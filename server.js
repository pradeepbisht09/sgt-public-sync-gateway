require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const initSqlJs = require("sql.js");

const PORT = process.env.PORT || 4000;
const TOKEN = String(process.env.SYNC_TOKEN || "");

const ROOT = __dirname;
const DATA = path.join(ROOT, "data");
const DBFILE = path.join(DATA, "public-tracking.sqlite");

let db;

const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

// CORS
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Referrer-Policy",
    "strict-origin-when-cross-origin"
  );

  const origin = req.headers.origin;

  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Vary", "Origin");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type,X-Sync-Token"
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,OPTIONS"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// -------------------------
// Database helpers
// -------------------------

function q(sql, args = []) {
  const st = db.prepare(sql);
  st.bind(args);

  const out = [];

  while (st.step()) {
    out.push(st.getAsObject());
  }

  st.free();

  return out;
}

function run(sql, args = []) {
  db.run(sql, args);
}

function save() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(
    DBFILE,
    Buffer.from(db.export())
  );
}

function now() {
  return new Date().toISOString();
}

// -------------------------
// Sync authentication
// -------------------------

function authSync(req, res, next) {
  if (!TOKEN) {
    return res.status(500).json({
      error: "SYNC_TOKEN is not configured"
    });
  }

  if (req.get("X-Sync-Token") !== TOKEN) {
    return res.status(401).json({
      error: "Invalid sync token"
    });
  }

  next();
}

// -------------------------
// Database initialization
// -------------------------

async function main() {
  const SQL = await initSqlJs();

  fs.mkdirSync(DATA, { recursive: true });

  if (fs.existsSync(DBFILE)) {
    db = new SQL.Database(
      fs.readFileSync(DBFILE)
    );
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS consignments(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lr_no TEXT UNIQUE,
      booking_date TEXT,
      from_station TEXT,
      to_station TEXT,
      packages INTEGER,
      weight REAL,
      chargeable_weight REAL,
      status TEXT,
      vehicle_no TEXT,
      remarks TEXT,
      current_station TEXT,
      expected_delivery_date TEXT,
      delivery_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS status_history(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lr_no TEXT,
      status TEXT,
      location TEXT,
      remarks TEXT,
      changed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS stations(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      code TEXT
    );

    CREATE TABLE IF NOT EXISTS branches(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      station TEXT,
      phone TEXT,
      address TEXT
    );
  `);

  save();

  // -------------------------
  // Health
  // -------------------------

  app.get("/health", (req, res) => {
    res.json({
      ok: true,
      service: "SGT Public Sync Gateway",
      time: now()
    });
  });

  // -------------------------
  // Sync events
  // -------------------------

  app.post(
    "/sync/v1/events",
    authSync,
    (req, res) => {
      try {
        const b = req.body || {};

        /*
         * ------------------------------------------------
         * PUBLIC CONFIG
         * ------------------------------------------------
         */

        if (
          b.company &&
          Array.isArray(b.stations)
        ) {
          /*
           * Only replace station/branch data when
           * actual arrays are supplied.
           *
           * This prevents an accidental empty payload
           * from wiping the public database.
           */

          if (b.stations.length > 0) {
            run("DELETE FROM stations");

            for (const x of b.stations) {
              const name = String(x?.name || "").trim();
              const code = String(x?.code || "").trim();

              if (!name) continue;

              run(
                "INSERT OR REPLACE INTO stations(name,code) VALUES(?,?)",
                [name, code]
              );
            }
          }

          if (
            Array.isArray(b.branches) &&
            b.branches.length > 0
          ) {
            run("DELETE FROM branches");

            for (const x of b.branches) {
              const name = String(x?.name || "").trim();
              const station = String(x?.station || "").trim();
              const phone = String(x?.phone || "").trim();
              const address = String(x?.address || "").trim();

              if (!name) continue;

              run(
                `INSERT OR REPLACE INTO branches
                 (name,station,phone,address)
                 VALUES(?,?,?,?)`,
                [
                  name,
                  station,
                  phone,
                  address
                ]
              );
            }
          }

          save();

          return res.json({
            ok: true,
            type: "PUBLIC_CONFIG",
            stations: q(
              "SELECT name,code FROM stations ORDER BY name"
            ).length,
            branches: q(
              "SELECT name,station,phone,address FROM branches ORDER BY name"
            ).length
          });
        }

        /*
         * ------------------------------------------------
         * CONSIGNMENT / LR
         * ------------------------------------------------
         */

        if (b.lrNo) {
          const lrNo = String(b.lrNo).trim();

          if (!lrNo) {
            return res.status(400).json({
              error: "Invalid LR number"
            });
          }

          run(
            `
            INSERT INTO consignments(
              lr_no,
              booking_date,
              from_station,
              to_station,
              packages,
              weight,
              chargeable_weight,
              status,
              vehicle_no,
              remarks,
              current_station,
              expected_delivery_date,
              delivery_at,
              updated_at
            )
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(lr_no)
            DO UPDATE SET
              booking_date=excluded.booking_date,
              from_station=excluded.from_station,
              to_station=excluded.to_station,
              packages=excluded.packages,
              weight=excluded.weight,
              chargeable_weight=excluded.chargeable_weight,
              status=excluded.status,
              vehicle_no=excluded.vehicle_no,
              remarks=excluded.remarks,
              current_station=excluded.current_station,
              expected_delivery_date=excluded.expected_delivery_date,
              delivery_at=excluded.delivery_at,
              updated_at=excluded.updated_at
            `,
            [
              lrNo,
              b.bookingDate || null,
              b.from || "",
              b.to || "",
              Number(b.packages || 0),
              Number(b.weight || 0),
              Number(b.chargeableWeight || 0),
              b.status || "",
              b.vehicleNo || "",
              b.remarks || "",
              b.currentStation || "",
              b.expectedDeliveryDate || null,
              b.deliveryAt || null,
              now()
            ]
          );

          /*
           * Replace public status history for this LR.
           */

          run(
            "DELETE FROM status_history WHERE lr_no=?",
            [lrNo]
          );

          if (Array.isArray(b.history)) {
            for (const h of b.history) {
              run(
                `
                INSERT INTO status_history(
                  lr_no,
                  status,
                  location,
                  remarks,
                  changed_at
                )
                VALUES(?,?,?,?,?)
                `,
                [
                  lrNo,
                  h?.status || "",
                  h?.location || "",
                  h?.remarks || "",
                  h?.changed_at || now()
                ]
              );
            }
          }

          save();

          return res.json({
            ok: true,
            type: "CONSIGNMENT_UPSERT",
            lrNo: lrNo
          });
        }

        /*
         * ------------------------------------------------
         * Unsupported event
         * ------------------------------------------------
         */

        return res.status(400).json({
          error: "Unsupported sync event"
        });

      } catch (e) {
        console.error(
          "Sync event error:",
          e
        );

        return res.status(400).json({
          error: e.message
        });
      }
    }
  );

  // -------------------------
  // Public configuration
  // -------------------------

  app.get(
    "/api/public/config",
    (req, res) => {
      res.json({
        company: "Shivam Golden Transport Co.",

        stations: q(
          "SELECT name,code FROM stations ORDER BY name"
        ),

        branches: q(
          "SELECT name,station,phone,address FROM branches ORDER BY name"
        ),

        tracking_endpoint:
          "/api/public/track/:lr",

        date_format:
          "DD/MM/YYYY"
      });
    }
  );

  // -------------------------
  // Public LR tracking
  // -------------------------

  app.get(
    "/api/public/track/:lr",
    (req, res) => {
      try {
        const lr = String(
          req.params.lr || ""
        ).trim();

        if (!lr) {
          return res.status(400).json({
            error: "LR number is required"
          });
        }

        const c = q(
          `
          SELECT *
          FROM consignments
          WHERE UPPER(lr_no)=UPPER(?)
          `,
          [lr]
        )[0];

        if (!c) {
          return res.status(404).json({
            error: "Consignment not found"
          });
        }

        const history = q(
          `
          SELECT
            status,
            location,
            remarks,
            changed_at
          FROM status_history
          WHERE lr_no=?
          ORDER BY id
          `,
          [c.lr_no]
        );

        return res.json({
          lrNo: c.lr_no,
          bookingDate: c.booking_date,
          from: c.from_station,
          to: c.to_station,
          packages: c.packages,
          weight: c.weight,
          chargeableWeight: c.chargeable_weight,
          status: c.status,
          vehicleNo: c.vehicle_no,
          remarks: c.remarks,
          currentStation: c.current_station,
          expectedDeliveryDate:
            c.expected_delivery_date,
          deliveryAt: c.delivery_at,
          history: history
        });

      } catch (e) {
        console.error(
          "Tracking error:",
          e
        );

        return res.status(500).json({
          error: "Tracking service error"
        });
      }
    }
  );

  // -------------------------
  // Start server
  // -------------------------

  app.listen(
    PORT,
    () => {
      console.log(
        `SGT Public Sync Gateway running on http://localhost:${PORT}`
      );
    }
  );
}

main().catch(
  e => {
    console.error(e);
    process.exit(1);
  }
);
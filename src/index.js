import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import http from "http";
import { Server } from "socket.io";

import { env } from "./config/environment.js";

import authRoutes from "./routes/authRoutes.js";
import teamRoutes from "./routes/teamRoutes.js";
import playerRoutes from "./routes/playerRoutes.js";
import auctionRoutes from "./routes/auctionRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import tradeRoutes from "./routes/tradeRoutes.js";

import { query } from "./database/connection.js";
import { errorResponse } from "./utils/response.js";

import { attachSocketHandlers } from "./socket/index.js";

/*
|--------------------------------------------------------------------------
| APP
|--------------------------------------------------------------------------
*/

const app = express();

/*
|--------------------------------------------------------------------------
| TRUST PROXY
|--------------------------------------------------------------------------
|
| Required when running behind Render's proxy.
|
*/

app.set(
  "trust proxy",
  env.NODE_ENV === "production" ? 1 : false
);

/*
|--------------------------------------------------------------------------
| ALLOWED CORS ORIGINS
|--------------------------------------------------------------------------
*/

const allowedOrigins = [
  "https://rotaract-ipl.vercel.app",

  // Local development
  "http://localhost:5173",
  "http://localhost:3000",
];

/*
|--------------------------------------------------------------------------
| CORS CONFIGURATION
|--------------------------------------------------------------------------
*/

const corsOptions = {
  origin(origin, callback) {
    /*
     * Requests without an Origin header can happen from:
     * - curl
     * - Postman
     * - server-to-server requests
     * - health checks
     */

    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.warn(`[CORS] Rejected origin: ${origin}`);

    return callback(
      new Error(`CORS blocked origin: ${origin}`)
    );
  },

  credentials: true,

  methods: [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
  ],

  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
  ],

  exposedHeaders: [
    "Content-Length",
    "Content-Type",
  ],

  maxAge: 86400,
};

/*
|--------------------------------------------------------------------------
| HTTP SERVER
|--------------------------------------------------------------------------
*/

const server = http.createServer(app);

/*
|--------------------------------------------------------------------------
| SOCKET.IO
|--------------------------------------------------------------------------
*/

const io = new Server(server, {
  cors: {
    origin: corsOptions.origin,
    credentials: true,

    methods: [
      "GET",
      "POST",
    ],
  },

  transports: [
    "polling",
    "websocket",
  ],

  /*
   * Useful for production connections.
   */

  pingInterval: 25000,
  pingTimeout: 20000,

  /*
   * Prevent extremely large socket payloads.
   */

  maxHttpBufferSize: 1e6,
});

app.set("io", io);

/*
|--------------------------------------------------------------------------
| SECURITY MIDDLEWARE
|--------------------------------------------------------------------------
*/

app.use(
  helmet({
    crossOriginResourcePolicy: {
      policy: "cross-origin",
    },
  })
);

/*
|--------------------------------------------------------------------------
| CORS
|--------------------------------------------------------------------------
*/

app.use(cors(corsOptions));

/*
|--------------------------------------------------------------------------
| BODY PARSING
|--------------------------------------------------------------------------
*/

app.use(
  express.json({
    limit: "2mb",
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "2mb",
  })
);

/*
|--------------------------------------------------------------------------
| RATE LIMITING
|--------------------------------------------------------------------------
*/

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,

  max: 300,

  standardHeaders: true,

  legacyHeaders: false,

  message: {
    success: false,
    message: "Too many requests. Please try again later.",
  },
});

/*
|--------------------------------------------------------------------------
| AUTH RATE LIMITER
|--------------------------------------------------------------------------
|
| Login/register endpoints should have stricter protection.
|
*/

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,

  max: 50,

  standardHeaders: true,

  legacyHeaders: false,

  message: {
    success: false,
    message: "Too many authentication attempts. Please try again later.",
  },
});

/*
|--------------------------------------------------------------------------
| GLOBAL API RATE LIMIT
|--------------------------------------------------------------------------
*/

app.use("/api", apiLimiter);

/*
|--------------------------------------------------------------------------
| HEALTH CHECK
|--------------------------------------------------------------------------
|
| Lightweight server health check.
|
*/

app.get("/", (_req, res) => {
  return res.status(200).json({
    success: true,
    service: "rotaract-backend",
    status: "running",
    environment: env.NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

/*
|--------------------------------------------------------------------------
| SERVER HEALTH
|--------------------------------------------------------------------------
|
| Does NOT query the database.
|
*/

app.get("/api/health", (_req, res) => {
  return res.status(200).json({
    success: true,
    status: "ok",
    service: "rotaract-backend",
    timestamp: new Date().toISOString(),
  });
});

/*
|--------------------------------------------------------------------------
| DATABASE HEALTH
|--------------------------------------------------------------------------
|
| Useful for debugging Neon connectivity.
|
*/

app.get("/api/health/db", async (_req, res) => {
  try {
    await query("SELECT 1");

    return res.status(200).json({
      success: true,
      status: "ok",
      database: "connected",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error(
      "[HEALTH] Database error:",
      error
    );

    return res.status(503).json({
      success: false,
      status: "error",
      database: "unavailable",
      timestamp: new Date().toISOString(),
    });
  }
});

/*
|--------------------------------------------------------------------------
| TEST ROUTE
|--------------------------------------------------------------------------
*/

app.get("/api/test", (_req, res) => {
  return res.status(200).json({
    success: true,
    message: "Server is running",
  });
});

/*
|--------------------------------------------------------------------------
| API ROUTES
|--------------------------------------------------------------------------
*/

/*
 * Authentication gets its own stricter rate limiter.
 */

app.use(
  "/api/auth",
  authLimiter,
  authRoutes
);

app.use(
  "/api/teams",
  teamRoutes
);

app.use(
  "/api/players",
  playerRoutes
);

app.use(
  "/api/auction",
  auctionRoutes
);

app.use(
  "/api/admin",
  adminRoutes
);

app.use(
  "/api/trades",
  tradeRoutes
);

/*
|--------------------------------------------------------------------------
| SOCKET CONNECTION LOGGING
|--------------------------------------------------------------------------
*/

io.on("connection", (socket) => {
  console.log(
    `[SOCKET] Connected: ${socket.id}`
  );

  socket.on("disconnect", (reason) => {
    console.log(
      `[SOCKET] Disconnected: ${socket.id} | ${reason}`
    );
  });

  socket.on("error", (error) => {
    console.error(
      `[SOCKET] Error: ${socket.id}`,
      error
    );
  });
});

/*
|--------------------------------------------------------------------------
| YOUR SOCKET HANDLERS
|--------------------------------------------------------------------------
*/

attachSocketHandlers(io);

/*
|--------------------------------------------------------------------------
| 404 HANDLER
|--------------------------------------------------------------------------
*/

app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message: "Route not found",
    path: req.originalUrl,
  });
});

/*
|--------------------------------------------------------------------------
| GLOBAL ERROR HANDLER
|--------------------------------------------------------------------------
*/

app.use((err, req, res, _next) => {
  console.error(
    "[EXPRESS ERROR]",
    {
      message: err?.message,
      method: req.method,
      path: req.originalUrl,
      stack:
        process.env.NODE_ENV === "production"
          ? undefined
          : err?.stack,
    }
  );

  /*
   * CORS error
   */

  if (
    err?.message?.startsWith("CORS blocked")
  ) {
    return res.status(403).json({
      success: false,
      message: "Origin not allowed",
    });
  }

  /*
   * Don't expose internal errors in production.
   */

  return res.status(500).json({
    success: false,
    message:
      env.NODE_ENV === "production"
        ? "Internal server error"
        : err?.message || "Server error",
  });
});

/*
|--------------------------------------------------------------------------
| PROCESS ERROR HANDLING
|--------------------------------------------------------------------------
*/

process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "[PROCESS] Uncaught exception:",
      error
    );
  }
);

process.on(
  "unhandledRejection",
  (reason) => {
    console.error(
      "[PROCESS] Unhandled rejection:",
      reason
    );
  }
);

/*
|--------------------------------------------------------------------------
| GRACEFUL SHUTDOWN
|--------------------------------------------------------------------------
*/

let isShuttingDown = false;

const shutdown = async (signal) => {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  console.log(
    `[SERVER] ${signal} received. Shutting down...`
  );

  /*
   * Stop accepting new HTTP connections.
   */

  server.close(async () => {
    console.log(
      "[SERVER] HTTP server closed."
    );

    try {
      /*
       * Close Socket.IO connections.
       */

      io.close();

      console.log(
        "[SERVER] Socket.IO closed."
      );
    } catch (error) {
      console.error(
        "[SERVER] Shutdown error:",
        error
      );
    }

    process.exit(0);
  });

  /*
   * Safety timeout.
   */

  setTimeout(() => {
    console.error(
      "[SERVER] Forced shutdown."
    );

    process.exit(1);
  }, 10000).unref();
};

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);

/*
|--------------------------------------------------------------------------
| START SERVER
|--------------------------------------------------------------------------
*/

const PORT = Number(
  env.PORT || process.env.PORT || 5002
);

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "======================================"
    );

    console.log(
      `[SERVER] Running on port ${PORT}`
    );

    console.log(
      `[SERVER] Environment: ${env.NODE_ENV}`
    );

    console.log(
      `[SERVER] Client: ${env.CLIENT_URL}`
    );

    console.log(
      "======================================"
    );
  }
);

/*
|--------------------------------------------------------------------------
| SERVER ERROR
|--------------------------------------------------------------------------
*/

server.on(
  "error",
  (error) => {
    console.error(
      "[HTTP SERVER ERROR]",
      error
    );
  }
);
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

import {
  errorResponse,
  successResponse,
} from "./utils/response.js";

import { attachSocketHandlers } from "./socket/index.js";

const app = express();

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
    origin: env.CLIENT_URL,
    methods: ["GET", "POST"],
    credentials: true,
  },

  // Allow Socket.IO to negotiate the best transport.
  transports: ["polling", "websocket"],
});

app.set("io", io);

/*
|--------------------------------------------------------------------------
| MIDDLEWARE
|--------------------------------------------------------------------------
*/

app.use(helmet());

app.use(
  cors({
    origin: env.CLIENT_URL,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  })
);

app.use(express.json({ limit: "2mb" }));

app.use(
  express.urlencoded({
    extended: true,
  })
);

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

/*
|--------------------------------------------------------------------------
| HEALTH CHECK
|--------------------------------------------------------------------------
*/

app.get("/api/health", async (_req, res) => {
  try {
    await query("SELECT 1");

    return successResponse(res, {
      status: "ok",
      db: "connected",
    });
  } catch (error) {
    console.error("Health check DB error:", error);

    return errorResponse(
      res,
      "DB unavailable",
      500,
      "DB_UNAVAILABLE"
    );
  }
});

/*
|--------------------------------------------------------------------------
| TEST ROUTE
|--------------------------------------------------------------------------
*/

app.get("/api/test", (_req, res) => {
  return successResponse(res, {
    message: "Server is running",
  });
});

/*
|--------------------------------------------------------------------------
| API ROUTES
|--------------------------------------------------------------------------
*/

app.use("/api/auth", authRoutes);
app.use("/api/teams", teamRoutes);
app.use("/api/players", playerRoutes);
app.use("/api/auction", auctionRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/trades", tradeRoutes);

/*
|--------------------------------------------------------------------------
| SOCKET.IO CONNECTION LOGGING
|--------------------------------------------------------------------------
*/

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.on("disconnect", (reason) => {
    console.log(
      "Socket disconnected:",
      socket.id,
      "Reason:",
      reason
    );
  });

  socket.on("error", (error) => {
    console.error(
      "Socket error:",
      socket.id,
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
| ERROR HANDLER
|--------------------------------------------------------------------------
*/

app.use((err, _req, res, _next) => {
  console.error("Express error:", err);

  if (err) {
    return errorResponse(
      res,
      err.message || "Server error",
      500,
      "SERVER_ERROR"
    );
  }

  return res.status(500).json({
    success: false,
    message: "Unknown error",
  });
});

/*
|--------------------------------------------------------------------------
| START SERVER
|--------------------------------------------------------------------------
*/

const PORT = env.PORT || 5002;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Client URL: ${env.CLIENT_URL}`);
});

server.on("error", (error) => {
  console.error("HTTP server error:", error);
});
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
import { errorResponse, successResponse } from "./utils/response.js";
import { attachSocketHandlers } from "./socket/index.js";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: env.CLIENT_URL,
    methods: ["GET", "POST"],
    credentials: true,
  },
});
app.set("io", io);

app.use(helmet());
app.use(cors({ origin: env.CLIENT_URL, credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));

app.get("/api/health", async (_req, res) => {
  try {
    await query("SELECT 1");
    return successResponse(res, { status: "ok", db: "connected" });
  } catch (error) {
    return errorResponse(res, "DB unavailable", 500, "DB_UNAVAILABLE");
  }
});

app.use("/api/auth", authRoutes);
app.use("/api/teams", teamRoutes);
app.use("/api/players", playerRoutes);
app.use("/api/auction", auctionRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/trades", tradeRoutes);

app.get("/api/test", (_req, res) => {
  return successResponse(res, { message: "Server is running" });
});

app.use((err, _req, res, _next) => {
  if (err) {
    return errorResponse(
      res,
      err.message || "Server error",
      500,
      "SERVER_ERROR",
    );
  }
  return res.status(500).json({ success: false, message: "Unknown error" });
});

attachSocketHandlers(io);

server.listen(env.PORT, () => {
  console.log(`Server listening on http://localhost:${env.PORT}`);
});

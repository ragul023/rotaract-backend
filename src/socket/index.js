import jwt from "jsonwebtoken";
import { env } from "../config/environment.js";
import { query } from "../database/connection.js";
import { getAuctionState, lockBid } from "../services/auctionService.js";
import { TEAM_APPROVAL_REQUIRED_MESSAGE } from "../middleware/auth.js";

export const attachSocketHandlers = (io) => {
  let activeVoiceAdminId = null;

  const stopVoiceBroadcast = (adminId) => {
    if (activeVoiceAdminId !== adminId) return;
    activeVoiceAdminId = null;
    io.to("auction-room").emit("voice_broadcast_stopped");
  };

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error("Authentication required"));
    }

    try {
      const decoded = jwt.verify(token, env.JWT_SECRET);
      const result = await query(
        "SELECT id, email, role, name FROM users WHERE id = $1",
        [decoded.userId],
      );
      if (result.rowCount === 0) {
        return next(new Error("User not found"));
      }

      socket.user = { ...result.rows[0], teamId: decoded.teamId || null };
      next();
    } catch (error) {
      next(new Error("Invalid token"));
    }
  });

  io.on("connection", (socket) => {
    if (["SUPER_ADMIN", "AUCTION_ADMIN"].includes(socket.user.role)) {
      socket.join("admin-room");
    }

    socket.on("join_game", async () => {
      socket.join("auction-room");
      if (socket.user.teamId) socket.join(`team:${socket.user.teamId}`);
      socket.emit("voice_broadcast_status", {
        adminId: activeVoiceAdminId,
      });
      socket.emit("participant_connected", {
        user: socket.user.name,
        role: socket.user.role,
      });
      const state = await getAuctionState();
      socket.emit("auction_state", { state });
      io.to("auction-room").emit("auction_state", {
        type: "participant_connected",
        user: socket.user.name,
        role: socket.user.role,
        connected: true,
      });
    });

    socket.on("voice_status_request", () => {
      socket.emit("voice_broadcast_status", {
        adminId: activeVoiceAdminId,
      });
    });

    socket.on("voice_broadcast_start", (acknowledge) => {
      if (
        !["SUPER_ADMIN", "AUCTION_ADMIN"].includes(socket.user.role) ||
        !socket.rooms.has("auction-room")
      ) {
        acknowledge?.({ success: false, message: "Admin access required" });
        return;
      }
      if (activeVoiceAdminId && activeVoiceAdminId !== socket.id) {
        acknowledge?.({
          success: false,
          message: "Another admin is broadcasting",
        });
        return;
      }

      activeVoiceAdminId = socket.id;
      io.to("auction-room").emit("voice_broadcast_started", {
        adminId: socket.id,
      });
      acknowledge?.({ success: true });
    });

    socket.on("voice_broadcast_stop", () => {
      if (["SUPER_ADMIN", "AUCTION_ADMIN"].includes(socket.user.role)) {
        stopVoiceBroadcast(socket.id);
      }
    });

    socket.on("voice_listener_join", () => {
      if (
        socket.user.role !== "PARTICIPANT" ||
        !socket.user.teamId ||
        !socket.rooms.has("auction-room") ||
        !activeVoiceAdminId
      ) {
        return;
      }
      io.to(activeVoiceAdminId).emit("voice_listener_joined", {
        listenerId: socket.id,
      });
    });

    socket.on("voice_signal", (payload) => {
      const target = io.sockets.sockets.get(payload?.targetId);
      if (
        !target ||
        !socket.rooms.has("auction-room") ||
        !target.rooms.has("auction-room") ||
        !payload?.signal ||
        (socket.id !== activeVoiceAdminId &&
          target.id !== activeVoiceAdminId) ||
        (socket.id === activeVoiceAdminId &&
          target.user.role !== "PARTICIPANT") ||
        (target.id === activeVoiceAdminId && socket.user.role !== "PARTICIPANT")
      ) {
        return;
      }
      target.emit("voice_signal", {
        fromId: socket.id,
        signal: payload.signal,
      });
    });

    socket.on("place_bid", async (payload, acknowledge) => {
      try {
        if (socket.user.role !== "PARTICIPANT" || !socket.user.teamId) {
          throw new Error("Only team participants can place bids");
        }
        const team = await query(
          "SELECT registration_status FROM college_teams WHERE id = $1",
          [socket.user.teamId],
        );
        if (
          team.rowCount === 0 ||
          team.rows[0].registration_status !== "CONFIRMED"
        ) {
          const approvalError = new Error(TEAM_APPROVAL_REQUIRED_MESSAGE);
          approvalError.code = "TEAM_PAYMENT_NOT_APPROVED";
          throw approvalError;
        }
        if (
          !payload ||
          typeof payload.playerId !== "string" ||
          typeof payload.amount !== "number" ||
          !Number.isFinite(payload.amount) ||
          payload.amount < 0
        ) {
          throw new Error("Invalid bid");
        }

        const result = await lockBid({
          teamId: socket.user.teamId,
          amount: payload.amount,
          playerId: payload.playerId,
        });
        const state = await getAuctionState();
        const update = {
          bidder: socket.user.name,
          amount: result.amount,
          teamId: socket.user.teamId,
          playerId: payload.playerId,
          sequence: result.nextSequence,
          status: "accepted",
        };
        io.to("auction-room").emit("auction_state", { state });
        io.to("auction-room").emit("bid_updated", update);
        acknowledge?.({ success: true, bid: update });
      } catch (error) {
        acknowledge?.({
          success: false,
          code: error.code,
          message: error.message || "Bid failed",
        });
        socket.emit("bid_rejected", {
          code: error.code,
          message: error.message || "Bid failed",
        });
      }
    });

    socket.on("disconnect", () => {
      if (socket.id === activeVoiceAdminId) {
        stopVoiceBroadcast(socket.id);
      } else if (activeVoiceAdminId && socket.user.role === "PARTICIPANT") {
        io.to(activeVoiceAdminId).emit("voice_listener_left", {
          listenerId: socket.id,
        });
      }
      io.to("auction-room").emit("participant_disconnected", {
        user: socket.user?.name || "Unknown",
      });
    });
  });
};

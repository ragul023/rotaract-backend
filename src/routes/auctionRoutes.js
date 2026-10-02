import express from "express";
import { z } from "zod";
import {
  authMiddleware,
  requireRole,
  requireApprovedTeam,
  requireTeamAccess,
} from "../middleware/auth.js";
import { errorResponse, successResponse } from "../utils/response.js";
import { query } from "../database/connection.js";
import {
  getAssignments,
  getRevealSettings,
  revealAssignments,
} from "../services/objectiveService.js";
import {
  getAuctionState,
  startAuction,
  pauseAuction,
  resumeAuction,
  nextPlayer,
  forceSell,
  markUnsold,
  lockBid,
} from "../services/auctionService.js";
import { useSuperSteal } from "../services/specialPowerService.js";

const router = express.Router();

const bidSchema = z.object({
  playerId: z.string().uuid(),
  amount: z.number().positive(),
});

const emitPlayerResult = (io, state, acquisitionMethod = "AUCTION") => {
  if (!state || !["PLAYER_SOLD", "PLAYER_UNSOLD"].includes(state.status)) {
    return;
  }

  const sold = state.status === "PLAYER_SOLD";
  io?.to("auction-room").emit("player_result", {
    playerId: state.current_player_id,
    playerName: state.player_display_name || state.player_name || "Player",
    playerPhoto: state.player_photo || null,
    status: sold ? "SOLD" : "UNSOLD",
    teamName: sold ? state.highest_bidder_team_name : null,
    amount: sold ? Number(state.current_bid || 0) : null,
    acquisitionMethod: sold ? acquisitionMethod : null,
  });
  if (sold) io?.to("auction-room").emit("team_rosters_updated");
};

const auctionAction =
  (action, status = 200) =>
  async (req, res) => {
    try {
      await action(req);
      const state = await getAuctionState();
      const io = req.app.get("io");
      io?.to("auction-room").emit("auction_state", { state });
      emitPlayerResult(io, state);
      return successResponse(res, { state }, status);
    } catch (error) {
      return errorResponse(
        res,
        error.message || "Auction action failed",
        400,
        "AUCTION_ACTION_FAILED",
      );
    }
  };

const advanceAuction = async (req) => {
  const state = await nextPlayer();
  const settings = await getRevealSettings();
  if (settings.mode === "MANUAL") return state;

  const processed = await query(
    `SELECT COUNT(*)::int AS count FROM auction_players
     WHERE auction_id = $1 AND status IN ('SOLD', 'UNSOLD')`,
    [state.id],
  );
  const conditionReached =
    (settings.mode === "AFTER_PLAYERS" &&
      processed.rows[0].count >= settings.threshold) ||
    (settings.mode === "AT_END" && state.status === "AUCTION_COMPLETED");
  if (!conditionReached) return state;

  const eventPayload = {
    auctionId: state.id,
    mode: settings.mode,
    threshold: settings.threshold,
  };
  const existingEvent = await query(
    `SELECT id FROM auction_events WHERE type = 'REVEAL_CONDITION_REACHED'
     AND payload->>'auctionId' = $1 AND payload->>'mode' = $2
     AND payload->>'threshold' = $3 LIMIT 1`,
    [state.id, settings.mode, String(settings.threshold)],
  );
  if (existingEvent.rowCount > 0) return state;

  await query(
    "INSERT INTO auction_events (type, payload) VALUES ('REVEAL_CONDITION_REACHED', $1::jsonb)",
    [JSON.stringify(eventPayload)],
  );
  const io = req.app.get("io");
  let autoRevealed = false;
  if (settings.autoReveal) {
    try {
      await revealAssignments({ actorId: req.user.id });
      const assignments = await getAssignments();
      for (const assignment of assignments) {
        io?.to(`team:${assignment.team_id}`).emit("objective_revealed", {
          status: "REVEALED",
          franchiseName: assignment.franchise_name,
        });
      }
      autoRevealed = true;
    } catch {
      autoRevealed = false;
    }
  }
  io?.to("admin-room").emit("reveal_condition_reached", {
    ...eventPayload,
    processedPlayers: processed.rows[0].count,
    autoRevealed,
  });
  return state;
};

router.get("/state", authMiddleware, async (_req, res) => {
  const state = await getAuctionState();
  return successResponse(res, { state });
});

router.post(
  "/start",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  auctionAction(() => startAuction(), 201),
);

router.post(
  "/pause",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  auctionAction(() => pauseAuction()),
);

router.post(
  "/resume",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  auctionAction(() => resumeAuction()),
);

router.post(
  "/next",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  auctionAction(advanceAuction),
);

router.post(
  "/force-sell",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  auctionAction((req) =>
    forceSell({
      teamId: req.body.teamId,
      amount: Number(req.body.amount || 0),
    }),
  ),
);

router.post(
  "/unsold",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  auctionAction(() => markUnsold()),
);

router.post(
  "/bid",
  authMiddleware,
  requireRole("PARTICIPANT"),
  requireTeamAccess,
  requireApprovedTeam,
  async (req, res) => {
    try {
      const payload = bidSchema.parse(req.body);
      const result = await lockBid({
        teamId: req.user.teamId,
        amount: payload.amount,
        playerId: payload.playerId,
      });
      const state = await getAuctionState();
      req.app.get("io")?.to("auction-room").emit("auction_state", { state });
      req.app.get("io")?.to("auction-room").emit("bid_updated", {
        bidder: req.user.name,
        amount: result.amount,
        teamId: req.user.teamId,
        playerId: payload.playerId,
        sequence: result.nextSequence,
        status: "accepted",
      });
      return successResponse(res, { result });
    } catch (error) {
      return errorResponse(
        res,
        error.message || "Bid failed",
        400,
        "INVALID_BID",
      );
    }
  },
);

router.post(
  "/super-steal",
  authMiddleware,
  requireRole("PARTICIPANT"),
  requireTeamAccess,
  requireApprovedTeam,
  async (req, res) => {
    try {
      const { playerId } = z
        .object({ playerId: z.string().uuid() })
        .parse(req.body);
      const result = await useSuperSteal({
        teamId: req.user.teamId,
        actorId: req.user.id,
        playerId,
      });
      const state = await getAuctionState();
      const io = req.app.get("io");
      io?.to("auction-room").emit("auction_state", { state });
      emitPlayerResult(io, state, "SUPER_STEAL");
      io?.to("auction-room").emit("super_steal_claimed", result);
      return successResponse(res, { result, state });
    } catch (error) {
      return errorResponse(
        res,
        error.message || "Super Steal failed",
        400,
        "SUPER_STEAL_FAILED",
      );
    }
  },
);

export default router;

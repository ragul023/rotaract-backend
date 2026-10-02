import express from "express";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { successResponse } from "../utils/response.js";
import { errorResponse } from "../utils/response.js";
import {
  getAdminOverview,
  getAuctionState,
  getPlayerQueue,
  updatePlayerQueue,
} from "../services/auctionService.js";
import {
  calculateScores,
  assignTeamFranchise,
  getAssignments,
  getActiveFranchises,
  getLeaderboard,
  getRevealSettings,
  getScoringSettings,
  lockAssignments,
  randomizeAssignments,
  resetAssignments,
  revealAssignments,
  updateScoringSettings,
  updateRevealSettings,
} from "../services/objectiveService.js";
import { query } from "../database/connection.js";
import { z } from "zod";
import { getTradeWindow, setTradeWindow } from "../services/tradeService.js";
import {
  getAdminRegistrations,
  getRegistrationSettings,
  setRegistrationFee,
  verifyRegistrationPayment,
} from "../services/registrationService.js";

const router = express.Router();
const scoringSettingsSchema = z.object({
  target_player: z.number().int().min(0).max(100),
  captain_bonus: z.number().int().min(0).max(100),
  overseas: z.number().int().min(0).max(100),
  all_rounder: z.number().int().min(0).max(100),
});
const revealSettingsSchema = z
  .object({
    mode: z.enum(["MANUAL", "AFTER_PLAYERS", "AT_END"]),
    threshold: z.number().int().min(0).max(1000),
    autoReveal: z.boolean(),
  })
  .superRefine((settings, context) => {
    if (settings.mode === "AFTER_PLAYERS" && settings.threshold < 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["threshold"],
        message: "Enter a player threshold greater than zero",
      });
    }
  });
const playerQueueSchema = z
  .object({
    playerIds: z.array(z.string().uuid()).min(1).max(500),
  })
  .superRefine(({ playerIds }, context) => {
    if (new Set(playerIds).size !== playerIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["playerIds"],
        message: "A player can only appear once in the queue",
      });
    }
  });
const tradeWindowSchema = z.object({ open: z.boolean() });
const teamAssignmentSchema = z.object({ franchiseId: z.string().uuid() });
const registrationFeeSchema = z.object({
  fee: z.number().finite().min(0.01).max(10000000),
});

const assignmentAction = (action) => async (req, res) => {
  try {
    const result = await action(req);
    return successResponse(res, { result });
  } catch (error) {
    return errorResponse(
      res,
      error.message || "Assignment action failed",
      400,
      "ASSIGNMENT_ACTION_FAILED",
    );
  }
};

router.get(
  "/trade-window",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  async (_req, res) => successResponse(res, await getTradeWindow()),
);

router.put(
  "/trade-window",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  async (req, res) => {
    try {
      const { open } = tradeWindowSchema.parse(req.body);
      const result = await setTradeWindow({ actorId: req.user.id, open });
      req.app
        .get("io")
        ?.to("auction-room")
        .emit("trade_window_updated", result);
      return successResponse(res, result);
    } catch (error) {
      return errorResponse(
        res,
        error.message || "Unable to update trade window",
        400,
        "TRADE_WINDOW_UPDATE_FAILED",
      );
    }
  },
);

router.get(
  "/player-queue",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  async (_req, res) => successResponse(res, await getPlayerQueue()),
);

router.put(
  "/player-queue",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  async (req, res) => {
    try {
      const payload = playerQueueSchema.parse(req.body);
      const queue = await updatePlayerQueue({
        actorId: req.user.id,
        playerIds: payload.playerIds,
      });
      return successResponse(res, queue);
    } catch (error) {
      return errorResponse(
        res,
        error.message || "Player queue update failed",
        400,
        "PLAYER_QUEUE_UPDATE_FAILED",
      );
    }
  },
);

router.get(
  "/assignments",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  async (_req, res) =>
    successResponse(res, { assignments: await getAssignments() }),
);

router.get(
  "/franchises",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  async (_req, res) =>
    successResponse(res, { franchises: await getActiveFranchises() }),
);

router.put(
  "/assignments/:teamId",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  async (req, res) => {
    try {
      const teamId = z.string().uuid().parse(req.params.teamId);
      const { franchiseId } = teamAssignmentSchema.parse(req.body);
      const assignment = await assignTeamFranchise({
        actorId: req.user.id,
        teamId,
        franchiseId,
      });
      return successResponse(res, { assignment });
    } catch (error) {
      return errorResponse(
        res,
        error.message || "Unable to update team assignment",
        400,
        "TEAM_ASSIGNMENT_UPDATE_FAILED",
      );
    }
  },
);

router.post(
  "/assignments/randomize",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  assignmentAction((req) => {
    const payload = z
      .object({ scope: z.enum(["ALL", "UNASSIGNED"]) })
      .parse(req.body);
    return randomizeAssignments({ actorId: req.user.id, scope: payload.scope });
  }),
);

router.post(
  "/assignments/lock",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  assignmentAction((req) => lockAssignments({ actorId: req.user.id })),
);

router.post(
  "/assignments/reveal",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  assignmentAction(async (req) => {
    const payload = z
      .object({ teamId: z.string().uuid().optional() })
      .parse(req.body);
    const result = await revealAssignments({
      actorId: req.user.id,
      teamId: payload.teamId,
    });
    const assignments = await getAssignments();
    const revealed = payload.teamId
      ? assignments.filter(
          (assignment) => assignment.team_id === payload.teamId,
        )
      : assignments;
    for (const assignment of revealed) {
      if (assignment.assignment_status === "REVEALED") {
        req.app
          .get("io")
          ?.to(`team:${assignment.team_id}`)
          .emit("objective_revealed", {
            status: "REVEALED",
            franchiseName: assignment.franchise_name,
          });
      }
    }
    return result;
  }),
);

router.post(
  "/assignments/reset",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  assignmentAction((req) => resetAssignments({ actorId: req.user.id })),
);

router.post(
  "/scores/calculate",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  assignmentAction(async (req) => {
    const results = await calculateScores({ actorId: req.user.id });
    const leaderboard = await getLeaderboard();
    req.app.get("io")?.to("auction-room").emit("leaderboard_updated", {
      leaderboard,
    });
    return { calculated: results.length };
  }),
);

router.get(
  "/leaderboard",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  async (_req, res) =>
    successResponse(res, { leaderboard: await getLeaderboard() }),
);

router.get(
  "/scoring-settings",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  async (_req, res) =>
    successResponse(res, { scoring: await getScoringSettings() }),
);

router.put(
  "/scoring-settings",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  assignmentAction((req) => {
    const scoring = scoringSettingsSchema.parse(req.body);
    return updateScoringSettings({ actorId: req.user.id, scoring });
  }),
);

router.get(
  "/reveal-settings",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  async (_req, res) =>
    successResponse(res, { reveal: await getRevealSettings() }),
);

router.put(
  "/reveal-settings",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  assignmentAction((req) => {
    const settings = revealSettingsSchema.parse(req.body);
    return updateRevealSettings({ actorId: req.user.id, settings });
  }),
);

router.get(
  "/overview",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  async (_req, res) => {
    const data = await getAdminOverview();
    return successResponse(res, { ...data });
  },
);

router.get(
  "/teams",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  async (_req, res) => {
    const teams =
      await query(`SELECT ct.*, w.available_purse, w.spent_purse, COUNT(tm.id)::int AS member_count FROM college_teams ct
    LEFT JOIN wallets w ON w.team_id = ct.id
    LEFT JOIN team_members tm ON tm.team_id = ct.id
    GROUP BY ct.id, w.available_purse, w.spent_purse`);
    return successResponse(res, { teams: teams.rows });
  },
);

router.get(
  "/audit-logs",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  async (_req, res) => {
    const logs = await query(
      "SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 50",
    );
    return successResponse(res, { logs: logs.rows });
  },
);

router.get(
  "/registrations",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  async (_req, res) =>
    successResponse(res, { registrations: await getAdminRegistrations() }),
);

router.get(
  "/registration-settings",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  async (_req, res) => successResponse(res, await getRegistrationSettings()),
);

router.put(
  "/registration-settings",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  async (req, res) => {
    try {
      const { fee } = registrationFeeSchema.parse(req.body);
      return successResponse(res, await setRegistrationFee(fee));
    } catch (error) {
      return errorResponse(
        res,
        error.message || "Unable to update registration fee",
        400,
        "REGISTRATION_FEE_UPDATE_FAILED",
      );
    }
  },
);

router.post(
  "/registrations/:registrationId/verify",
  authMiddleware,
  requireRole("SUPER_ADMIN"),
  async (req, res) => {
    try {
      const teamId = z.string().uuid().parse(req.params.registrationId);
      const result = await verifyRegistrationPayment({
        teamId,
        adminId: req.user.id,
        approved: true,
      });
      const io = req.app.get("io");
      io?.to(`team:${teamId}`).emit("team_registration_updated", result);
      io?.to("auction-room").emit("team_rosters_updated");
      return successResponse(res, result);
    } catch (error) {
      return errorResponse(
        res,
        error.message || "Unable to verify payment",
        400,
        "PAYMENT_VERIFICATION_FAILED",
      );
    }
  },
);

router.post(
  "/registrations/:registrationId/reject",
  authMiddleware,
  requireRole("SUPER_ADMIN"),
  async (req, res) => {
    try {
      const teamId = z.string().uuid().parse(req.params.registrationId);
      const result = await verifyRegistrationPayment({
        teamId,
        adminId: req.user.id,
        approved: false,
      });
      const io = req.app.get("io");
      io?.to(`team:${teamId}`).emit("team_registration_updated", result);
      io?.to("auction-room").emit("team_rosters_updated");
      return successResponse(res, result);
    } catch (error) {
      return errorResponse(
        res,
        error.message || "Unable to reject payment",
        400,
        "PAYMENT_REJECTION_FAILED",
      );
    }
  },
);

export default router;

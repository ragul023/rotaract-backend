import express from "express";
import { z } from "zod";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { query, withTransaction } from "../database/connection.js";
import { successResponse, errorResponse } from "../utils/response.js";
import {
  getParticipantAssignment,
  getLeaderboard,
} from "../services/objectiveService.js";
import { getTeamPowerState } from "../services/specialPowerService.js";
import {
  getTeamRosters,
  getTeamTradeOffers,
} from "../services/tradeService.js";
import {
  getRegistrationSettings,
  getTeamRegistration,
} from "../services/registrationService.js";
import {
  createPaymentOrder,
  submitUpiReference,
} from "../services/paymentService.js";

const router = express.Router();

const createTeamSchema = z.object({
  name: z.string().min(3),
  leaderName: z.string().min(2),
  leaderEmail: z.string().email(),
  leaderRegisterNumber: z.string().min(2),
  department: z.string().min(2),
  password: z.string().min(6),
});

router.post(
  "/",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN"),
  async (req, res) => {
    try {
      const payload = createTeamSchema.parse(req.body);
      const code = `TEAM-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const teamResult = await query(
        "INSERT INTO college_teams (id, name, code, leader_id, purse, spent, status) VALUES (gen_random_uuid(), $1, $2, $3, 90, 0, $4) RETURNING *",
        [payload.name, code, req.user.id, "ACTIVE"],
      );
      const team = teamResult.rows[0];
      return successResponse(res, { team, teamCode: team.code }, 201);
    } catch (error) {
      return errorResponse(
        res,
        error.message || "Team creation failed",
        400,
        "TEAM_CREATE_FAILED",
      );
    }
  },
);

router.get("/registration-settings", async (_req, res) =>
  successResponse(res, await getRegistrationSettings()),
);

router.get("/me/registration", authMiddleware, async (req, res) =>
  successResponse(res, {
    registration: await getTeamRegistration(req.user.id),
  }),
);

router.post(
  "/me/payment-order",
  authMiddleware,
  requireRole("PARTICIPANT"),
  async (req, res) => {
    try {
      const payment = await createPaymentOrder(req.user.id);
      return successResponse(res, { payment });
    } catch (error) {
      return errorResponse(
        res,
        error.message || "Unable to create team payment",
        400,
        "PAYMENT_ORDER_FAILED",
      );
    }
  },
);

router.post(
  "/me/payment-reference",
  authMiddleware,
  requireRole("PARTICIPANT"),
  async (req, res) => {
    try {
      const { paymentReference } = z
        .object({ paymentReference: z.string().trim().min(6).max(255) })
        .parse(req.body);
      const payment = await submitUpiReference(req.user.id, paymentReference);
      return successResponse(res, { payment });
    } catch (error) {
      return errorResponse(
        res,
        error.message || "Unable to submit payment reference",
        400,
        "PAYMENT_REFERENCE_FAILED",
      );
    }
  },
);

router.get("/me", authMiddleware, async (req, res) => {
  const teamResult = await query(
    "SELECT ct.* FROM college_teams ct JOIN team_members tm ON tm.team_id = ct.id WHERE tm.user_id = $1 LIMIT 1",
    [req.user.id],
  );
  const walletResult = await query("SELECT * FROM wallets WHERE team_id = $1", [
    teamResult.rows[0]?.id || null,
  ]);
  const teamId = teamResult.rows[0]?.id || null;
  const team = teamResult.rows[0]
    ? {
        ...teamResult.rows[0],
        code:
          teamResult.rows[0].registration_status === "CONFIRMED"
            ? teamResult.rows[0].code
            : null,
      }
    : null;
  const members = teamId
    ? await query(
        `SELECT id, name, is_leader FROM team_members
         WHERE team_id = $1 ORDER BY is_leader DESC, created_at`,
        [teamId],
      )
    : { rows: [] };
  const squad = teamId
    ? await query(
        `SELECT p.id AS player_id, p.name, p.display_name, p.photo,
           p.country, p.role, p.is_captain, p.is_overseas,
            f.name AS franchise_name, s.acquired_price, s.created_at AS acquired_at,
            s.is_playing_xi
         FROM squads s
         JOIN players p ON p.id = s.player_id
         LEFT JOIN ipl_franchises f ON f.id = p.franchise_id
         WHERE s.team_id = $1
         ORDER BY s.created_at, p.name`,
        [teamId],
      )
    : { rows: [] };
  const powers = teamId ? await getTeamPowerState(teamId) : null;
  return successResponse(res, {
    team,
    wallet: walletResult.rows[0] || null,
    members: members.rows,
    players: squad.rows,
    powers,
  });
});

router.put(
  "/me/playing-xi",
  authMiddleware,
  requireRole("PARTICIPANT"),
  async (req, res) => {
    try {
      const { playerIds } = z
        .object({ playerIds: z.array(z.string().uuid()).length(11) })
        .parse(req.body);
      if (new Set(playerIds).size !== 11) {
        throw new Error("Choose 11 different players for your playing XI");
      }
      await withTransaction(async (client) => {
        const auction = await client.query(
          "SELECT status FROM auction ORDER BY created_at DESC LIMIT 1",
        );
        if (
          !auction.rowCount ||
          !["AUCTION_COMPLETED", "FINISHED"].includes(auction.rows[0].status)
        ) {
          throw new Error(
            "You can fix your playing XI after the auction is complete",
          );
        }
        const team = await client.query(
          "SELECT id, playing_xi_locked FROM college_teams WHERE id = $1 AND status = 'ACTIVE' FOR UPDATE",
          [req.user.teamId],
        );
        if (team.rowCount === 0) throw new Error("Active team not found");
        if (team.rows[0].playing_xi_locked) {
          throw new Error(
            "The playing XI is locked because scores are finalized",
          );
        }
        const roster = await client.query(
          "SELECT player_id FROM squads WHERE team_id = $1 FOR UPDATE",
          [team.rows[0].id],
        );
        if (roster.rowCount < 11 || roster.rowCount > 18) {
          throw new Error("Your squad must contain between 11 and 18 players");
        }
        const rosterIds = new Set(
          roster.rows.map((player) => player.player_id),
        );
        if (playerIds.some((playerId) => !rosterIds.has(playerId))) {
          throw new Error("The playing XI can only include your own players");
        }
        await client.query(
          `UPDATE squads SET is_playing_xi = player_id = ANY($2::uuid[])
           WHERE team_id = $1`,
          [team.rows[0].id, playerIds],
        );
      });
      req.app.get("io")?.to("auction-room").emit("team_rosters_updated");
      return successResponse(res, { saved: true });
    } catch (error) {
      return errorResponse(
        res,
        error.message || "Unable to fix the playing XI",
        400,
        "PLAYING_XI_FAILED",
      );
    }
  },
);

router.get("/rosters", authMiddleware, async (_req, res) => {
  return successResponse(res, { teams: await getTeamRosters() });
});

router.get("/me/trades", authMiddleware, async (req, res) => {
  if (!req.user.teamId) {
    return errorResponse(res, "Team membership required", 403, "TEAM_REQUIRED");
  }
  return successResponse(res, {
    offers: await getTeamTradeOffers(req.user.teamId),
  });
});

router.get("/me/assignment", authMiddleware, async (req, res) => {
  const teamResult = await query(
    "SELECT team_id FROM team_members WHERE user_id = $1 LIMIT 1",
    [req.user.id],
  );
  if (teamResult.rowCount === 0) {
    return successResponse(res, { assignment: null });
  }
  const assignment = await getParticipantAssignment(teamResult.rows[0].team_id);
  return successResponse(res, { assignment });
});

router.get("/leaderboard", authMiddleware, async (_req, res) => {
  const leaderboard = await getLeaderboard();
  return successResponse(res, { leaderboard });
});

export default router;

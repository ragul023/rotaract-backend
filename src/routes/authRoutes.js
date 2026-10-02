import express from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { query } from "../database/connection.js";
import { env } from "../config/environment.js";
import {
  comparePassword,
  createTeam,
  joinTeam,
  signRefreshToken,
  signToken,
} from "../services/authService.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { successResponse, errorResponse } from "../utils/response.js";

const router = express.Router();

const registerSchema = z.object({
  teamName: z.string().min(2),
  leaderName: z.string().min(2),
  leaderEmail: z.string().email(),
  leaderRegisterNumber: z.string().min(2),
  department: z.string().min(2),
  password: z.string().min(6),
});

const joinTeamSchema = z.object({
  teamCode: z.string().min(4),
  name: z.string().min(2),
  email: z.string().email(),
  registerNumber: z.string().min(2),
  department: z.string().min(2),
  password: z.string().min(6),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

router.post("/register", async (req, res) => {
  try {
    const payload = registerSchema.parse(req.body);
    const result = await createTeam(payload);
    const user = await query("SELECT * FROM users WHERE id = $1", [
      result.userId,
    ]);
    const accessToken = signToken(user.rows[0], result.teamId);
    const refreshToken = signRefreshToken(user.rows[0], result.teamId);

    return successResponse(
      res,
      {
        user: { ...user.rows[0], password_hash: undefined },
        teamId: result.teamId,
        accessToken,
        refreshToken,
      },
      201,
    );
  } catch (error) {
    return errorResponse(
      res,
      error.message || "Registration failed",
      400,
      "REGISTRATION_FAILED",
    );
  }
});

router.post("/login", async (req, res) => {
  try {
    const payload = loginSchema.parse(req.body);
    const userResult = await query("SELECT * FROM users WHERE email = $1", [
      payload.email,
    ]);

    if (userResult.rowCount === 0) {
      return errorResponse(
        res,
        "Invalid credentials",
        401,
        "INVALID_CREDENTIALS",
      );
    }

    const user = userResult.rows[0];
    const passwordMatch = await comparePassword(
      payload.password,
      user.password_hash,
    );
    if (!passwordMatch) {
      return errorResponse(
        res,
        "Invalid credentials",
        401,
        "INVALID_CREDENTIALS",
      );
    }

    const teamMember = await query(
      "SELECT team_id FROM team_members WHERE user_id = $1 LIMIT 1",
      [user.id],
    );
    const teamId = teamMember.rowCount > 0 ? teamMember.rows[0].team_id : null;

    const accessToken = signToken(user, teamId);
    const refreshToken = signRefreshToken(user, teamId);

    return successResponse(res, {
      user: { ...user, password_hash: undefined },
      teamId,
      accessToken,
      refreshToken,
    });
  } catch (error) {
    return errorResponse(
      res,
      error.message || "Login failed",
      400,
      "LOGIN_FAILED",
    );
  }
});

router.post("/join-team", async (req, res) => {
  try {
    const payload = joinTeamSchema.parse(req.body);
    const result = await joinTeam(payload);
    const user = await query("SELECT * FROM users WHERE email = $1", [
      payload.email,
    ]);
    const accessToken = signToken(user.rows[0], result.teamId);
    const refreshToken = signRefreshToken(user.rows[0], result.teamId);

    return successResponse(
      res,
      {
        user: { ...user.rows[0], password_hash: undefined },
        teamId: result.teamId,
        accessToken,
        refreshToken,
      },
      201,
    );
  } catch (error) {
    return errorResponse(
      res,
      error.message || "Unable to join team",
      400,
      "TEAM_JOIN_FAILED",
    );
  }
});

router.post("/logout", authMiddleware, async (_req, res) => {
  return successResponse(res, { message: "Logged out successfully" });
});

router.get("/me", authMiddleware, async (req, res) => {
  const result = await query(
    `SELECT u.id, u.email, u.role, u.name, u.is_active,
       tm.team_id,
       CASE WHEN ct.id IS NULL THEN NULL ELSE jsonb_build_object(
         'id', ct.id,
         'name', ct.name,
         'code', CASE WHEN ct.registration_status = 'CONFIRMED' THEN ct.code END,
         'registration_status', ct.registration_status,
         'status', ct.status,
         'purse', ct.purse,
         'spent', ct.spent,
         'is_captain', ct.leader_id = u.id
       ) END AS team
     FROM users u
     LEFT JOIN LATERAL (
       SELECT team_id FROM team_members
       WHERE user_id = u.id
       ORDER BY is_leader DESC, created_at
       LIMIT 1
     ) tm ON TRUE
     LEFT JOIN college_teams ct ON ct.id = tm.team_id
     WHERE u.id = $1`,
    [req.user.id],
  );
  if (result.rowCount === 0) {
    return errorResponse(res, "User not found", 404, "USER_NOT_FOUND");
  }
  const row = result.rows[0];
  return successResponse(res, {
    user: {
      id: row.id,
      email: row.email,
      role: row.role,
      name: row.name,
      is_active: row.is_active,
    },
    team: row.team,
    teamId: row.team_id,
  });
});

router.post("/refresh", async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken)
    return errorResponse(
      res,
      "Refresh token required",
      401,
      "REFRESH_REQUIRED",
    );

  let decoded;
  try {
    decoded = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET);
  } catch (_error) {
    return errorResponse(
      res,
      "Refresh token invalid",
      401,
      "INVALID_REFRESH_TOKEN",
    );
  }

  try {
    const userResult = await query(
      `SELECT u.id, u.email, u.role, u.name, u.is_active,
         (SELECT team_id FROM team_members
          WHERE user_id = u.id
          ORDER BY is_leader DESC, created_at LIMIT 1) AS team_id
       FROM users u WHERE u.id = $1`,
      [decoded.userId],
    );
    if (userResult.rowCount === 0 || !userResult.rows[0].is_active) {
      return errorResponse(res, "Session expired", 401, "SESSION_EXPIRED");
    }
    const user = userResult.rows[0];
    const accessToken = signToken(user, user.team_id || null);
    const nextRefreshToken = signRefreshToken(user, user.team_id || null);
    return successResponse(res, {
      accessToken,
      refreshToken: nextRefreshToken,
      teamId: user.team_id || null,
    });
  } catch (error) {
    console.error("Session refresh database error:", error);
    return errorResponse(
      res,
      "Session service is temporarily unavailable",
      503,
      "SESSION_SERVICE_UNAVAILABLE",
    );
  }
});

router.get(
  "/dev",
  authMiddleware,
  requireRole("SUPER_ADMIN", "AUCTION_ADMIN", "PARTICIPANT", "VIEWER"),
  (req, res) => {
    return successResponse(res, {
      dev: true,
      role: req.user.role,
      userId: req.user.id,
    });
  },
);

export default router;

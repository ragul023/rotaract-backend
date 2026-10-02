import jwt from "jsonwebtoken";
import { env } from "../config/environment.js";
import { query } from "../database/connection.js";
import { errorResponse } from "../utils/response.js";

export const TEAM_APPROVAL_REQUIRED_MESSAGE =
  "Your team's payment is not approved yet. Contact admin at 9698813344.";

export const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.split(" ")[1]
    : null;

  if (!token) {
    return errorResponse(res, "Authentication required", 401, "AUTH_REQUIRED");
  }

  let decoded;
  try {
    decoded = jwt.verify(token, env.JWT_SECRET);
  } catch {
    return errorResponse(res, "Invalid or expired token", 401, "INVALID_TOKEN");
  }

  try {
    const userResult = await query(
      `SELECT u.id, u.email, u.role, u.name, u.is_active,
         tm.team_id, ct.registration_status
       FROM users u
       LEFT JOIN LATERAL (
         SELECT team_id FROM team_members
         WHERE user_id = u.id AND team_id = $2
         LIMIT 1
       ) tm ON TRUE
       LEFT JOIN college_teams ct ON ct.id = tm.team_id
       WHERE u.id = $1`,
      [decoded.userId, decoded.teamId || null],
    );

    if (userResult.rowCount === 0 || !userResult.rows[0].is_active) {
      return errorResponse(
        res,
        "User not found or inactive",
        401,
        "INVALID_TOKEN",
      );
    }

    req.user = {
      id: userResult.rows[0].id,
      email: userResult.rows[0].email,
      role: userResult.rows[0].role,
      name: userResult.rows[0].name,
      teamId: userResult.rows[0].team_id || null,
      registrationStatus: userResult.rows[0].registration_status || null,
    };

    return next();
  } catch (error) {
    return next(error);
  }
};

export const requireRole =
  (...roles) =>
  (req, res, next) => {
    if (!req.user) {
      return errorResponse(res, "Unauthorized", 401, "AUTH_REQUIRED");
    }

    if (!roles.includes(req.user.role)) {
      return errorResponse(
        res,
        "Forbidden: insufficient role",
        403,
        "FORBIDDEN",
      );
    }

    return next();
  };

export const requireTeamAccess = async (req, res, next) => {
  if (!req.user || !req.user.teamId) {
    return errorResponse(res, "Team context required", 403, "TEAM_REQUIRED");
  }
  return next();
};

export const requireApprovedTeam = async (req, res, next) => {
  if (!req.user?.teamId) {
    return errorResponse(res, "Team context required", 403, "TEAM_REQUIRED");
  }
  if (req.user.registrationStatus !== "CONFIRMED") {
    return errorResponse(
      res,
      TEAM_APPROVAL_REQUIRED_MESSAGE,
      403,
      "TEAM_PAYMENT_NOT_APPROVED",
    );
  }
  return next();
};

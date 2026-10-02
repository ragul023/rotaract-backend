import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { query, withTransaction } from "../database/connection.js";
import { env } from "../config/environment.js";
import { randomCode } from "../utils/helpers.js";

export const signToken = (user, teamId = null) =>
  jwt.sign(
    { userId: user.id, role: user.role, teamId, email: user.email },
    env.JWT_SECRET,
    { expiresIn: "1d" },
  );

export const signRefreshToken = (user, teamId = null) =>
  jwt.sign(
    { userId: user.id, role: user.role, teamId },
    env.JWT_REFRESH_SECRET,
    { expiresIn: "1d" },
  );

export const hashPassword = async (password) => bcrypt.hash(password, 10);

export const comparePassword = async (password, hash) =>
  bcrypt.compare(password, hash);

export const createTeam = async ({
  teamName,
  leaderName,
  leaderEmail,
  leaderPhone,
  leaderRegisterNumber,
  department,
  password,
}) => {
  const teamCode = randomCode("TEAM");
  const userId = uuidv4();
  const teamId = uuidv4();

  const passwordHash = await hashPassword(password);

  await withTransaction(async (client) => {
    const existingUser = await client.query(
      "SELECT id FROM users WHERE email = $1",
      [leaderEmail],
    );
    if (existingUser.rowCount > 0) {
      throw new Error("User already exists");
    }

    await client.query(
      `INSERT INTO users (id, email, password_hash, role, name, phone) VALUES ($1, $2, $3, 'PARTICIPANT', $4, $5)`,
      [userId, leaderEmail, passwordHash, leaderName, leaderPhone],
    );

    await client.query(
      `INSERT INTO college_teams
        (id, name, code, leader_id, purse, spent, status, registration_status)
       VALUES ($1, $2, $3, $4, $5, $6, 'PENDING_PAYMENT', 'PENDING_PAYMENT')`,
      [teamId, teamName, teamCode, userId, 90.0, 0.0],
    );

    await client.query(
      `INSERT INTO team_members (id, team_id, user_id, name, email, register_number, department, is_leader) VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
      [
        uuidv4(),
        teamId,
        userId,
        leaderName,
        leaderEmail,
        leaderRegisterNumber,
        department,
      ],
    );

    await client.query(
      `INSERT INTO wallets (id, team_id, available_purse, spent_purse, bonus_purse) VALUES ($1, $2, $3, $4, $5)`,
      [uuidv4(), teamId, 90.0, 0.0, 0.0],
    );
  });
  return { userId, teamId };
};

export const joinTeam = async ({
  teamCode,
  name,
  email,
  registerNumber,
  department,
  password,
}) => {
  const userId = uuidv4();
  const passwordHash = await hashPassword(password);

  const teamId = await withTransaction(async (client) => {
    const teamResult = await client.query(
      `SELECT id FROM college_teams
       WHERE code = $1 AND registration_status = 'CONFIRMED' AND status = 'ACTIVE'
       FOR UPDATE`,
      [teamCode],
    );
    if (teamResult.rowCount === 0) throw new Error("Invalid team code");

    const team = teamResult.rows[0];
    const memberCount = await client.query(
      "SELECT COUNT(*)::int AS count FROM team_members WHERE team_id = $1",
      [team.id],
    );
    if (memberCount.rows[0].count >= 5) throw new Error("Team full");

    const existingUser = await client.query(
      "SELECT id FROM users WHERE email = $1",
      [email],
    );
    if (existingUser.rowCount > 0) throw new Error("User already exists");

    await client.query(
      `INSERT INTO users (id, email, password_hash, role, name) VALUES ($1, $2, $3, 'PARTICIPANT', $4)`,
      [userId, email, passwordHash, name],
    );

    await client.query(
      `INSERT INTO team_members (id, team_id, user_id, name, email, register_number, department, is_leader) VALUES ($1, $2, $3, $4, $5, $6, $7, false)`,
      [uuidv4(), team.id, userId, name, email, registerNumber, department],
    );

    return team.id;
  });
  return { userId, teamId };
};

export const getUserWithTeam = async (userId) => {
  const user = await query(
    `SELECT u.*, tm.team_id FROM users u LEFT JOIN team_members tm ON tm.user_id = u.id WHERE u.id = $1 LIMIT 1`,
    [userId],
  );

  return user.rows[0] || null;
};

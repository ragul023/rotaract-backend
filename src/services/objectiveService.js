import { randomInt } from "node:crypto";
import { query, withTransaction } from "../database/connection.js";

const recordAudit = async (client, actorId, action, target, value) => {
  await client.query(
    `INSERT INTO audit_logs (actor_user_id, action, target, new_value)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [actorId, action, target, JSON.stringify(value)],
  );
};

export const getScoringSettings = async () => {
  const result = await query(
    "SELECT value FROM game_settings WHERE key = 'scoring'",
  );
  const scoring = result.rows[0]?.value || {};
  return {
    target_player: Number(scoring.target_player ?? 1),
    captain_bonus: Number(
      scoring.captain_bonus ?? Math.max(Number(scoring.captain ?? 2) - 1, 0),
    ),
    overseas: Number(scoring.overseas ?? 1),
    all_rounder: Number(scoring.all_rounder ?? 1),
  };
};

export const updateScoringSettings = async ({ actorId, scoring }) =>
  withTransaction(async (client) => {
    await client.query(
      `INSERT INTO game_settings (key, value) VALUES ('scoring', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(scoring)],
    );
    await recordAudit(
      client,
      actorId,
      "SCORING_SETTINGS_UPDATED",
      null,
      scoring,
    );
    return scoring;
  });

export const getRevealSettings = async () => {
  const result = await query(
    "SELECT key, value FROM game_settings WHERE key IN ('reveal_mode', 'reveal_threshold', 'auto_reveal')",
  );
  const settings = Object.fromEntries(
    result.rows.map((row) => [row.key, row.value]),
  );
  return {
    mode: settings.reveal_mode || "MANUAL",
    threshold: Number(settings.reveal_threshold ?? 60),
    autoReveal: settings.auto_reveal === true,
  };
};

export const updateRevealSettings = async ({ actorId, settings }) =>
  withTransaction(async (client) => {
    const entries = [
      ["reveal_mode", settings.mode],
      ["reveal_threshold", settings.threshold],
      ["auto_reveal", settings.autoReveal],
    ];
    for (const [key, value] of entries) {
      await client.query(
        `INSERT INTO game_settings (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, JSON.stringify(value)],
      );
    }
    await recordAudit(
      client,
      actorId,
      "REVEAL_SETTINGS_UPDATED",
      null,
      settings,
    );
    return settings;
  });

export const getAssignments = async () => {
  const result = await query(
    `SELECT ct.id AS team_id, ct.name AS team_name,
       sa.status AS assignment_status, sa.revealed_at,
       f.id AS franchise_id, f.name AS franchise_name,
       COALESCE(json_agg(json_build_object('name', tm.name, 'email', tm.email))
         FILTER (WHERE tm.id IS NOT NULL), '[]'::json) AS members
     FROM college_teams ct
     LEFT JOIN secret_assignments sa ON sa.team_id = ct.id
     LEFT JOIN ipl_franchises f ON f.id = sa.franchise_id
     LEFT JOIN team_members tm ON tm.team_id = ct.id
     WHERE ct.status = 'ACTIVE'
     GROUP BY ct.id, sa.status, sa.revealed_at, f.id, f.name
     ORDER BY ct.name`,
  );
  return result.rows;
};

export const getActiveFranchises = async () => {
  const result = await query(
    "SELECT id, name FROM ipl_franchises WHERE is_active = TRUE ORDER BY name",
  );
  return result.rows;
};

export const randomizeAssignments = async ({ actorId, scope = "ALL" }) => {
  if (!["ALL", "UNASSIGNED"].includes(scope)) {
    throw new Error("Invalid assignment scope");
  }

  return withTransaction(async (client) => {
    if (scope === "ALL") {
      const locked = await client.query(
        "SELECT COUNT(*)::int AS count FROM secret_assignments WHERE status IN ('LOCKED', 'REVEALED')",
      );
      if (locked.rows[0].count > 0) {
        throw new Error(
          "Reset locked assignments before randomizing all teams",
        );
      }
    }

    const franchises = await client.query(
      "SELECT id FROM ipl_franchises WHERE is_active = true ORDER BY id",
    );
    if (franchises.rowCount === 0) throw new Error("No active franchises");

    const teams = await client.query(
      `SELECT ct.id FROM college_teams ct
       LEFT JOIN secret_assignments sa ON sa.team_id = ct.id
       WHERE ct.status = 'ACTIVE' ${scope === "UNASSIGNED" ? "AND sa.team_id IS NULL" : ""}
       ORDER BY ct.id FOR UPDATE OF ct`,
    );
    if (teams.rowCount === 0) return { assigned: 0 };

    for (const team of teams.rows) {
      const franchise = franchises.rows[randomInt(franchises.rowCount)];
      await client.query(
        `INSERT INTO secret_assignments (team_id, franchise_id, status, revealed_at)
         VALUES ($1, $2, 'ASSIGNED', NULL)
         ON CONFLICT (team_id) DO UPDATE SET franchise_id = EXCLUDED.franchise_id,
           status = 'ASSIGNED', revealed_at = NULL, updated_at = NOW()`,
        [team.id, franchise.id],
      );
    }

    await recordAudit(client, actorId, "ASSIGNMENTS_RANDOMIZED", scope, {
      assigned: teams.rowCount,
    });
    return { assigned: teams.rowCount };
  });
};

export const assignTeamFranchise = async ({ actorId, teamId, franchiseId }) =>
  withTransaction(async (client) => {
    const team = await client.query(
      "SELECT id FROM college_teams WHERE id = $1 AND status = 'ACTIVE' FOR UPDATE",
      [teamId],
    );
    if (team.rowCount === 0) throw new Error("Active team not found");

    const existing = await client.query(
      "SELECT status FROM secret_assignments WHERE team_id = $1 FOR UPDATE",
      [teamId],
    );
    if (["LOCKED", "REVEALED"].includes(existing.rows[0]?.status)) {
      throw new Error(
        "Reset assignments before editing locked or revealed targets",
      );
    }

    const franchise = await client.query(
      "SELECT id, name FROM ipl_franchises WHERE id = $1 AND is_active = TRUE",
      [franchiseId],
    );
    if (franchise.rowCount === 0) throw new Error("Active franchise not found");

    await client.query(
      `INSERT INTO secret_assignments (team_id, franchise_id, status, revealed_at)
       VALUES ($1, $2, 'ASSIGNED', NULL)
       ON CONFLICT (team_id) DO UPDATE SET franchise_id = EXCLUDED.franchise_id,
         status = 'ASSIGNED', revealed_at = NULL, updated_at = NOW()`,
      [teamId, franchiseId],
    );
    await recordAudit(client, actorId, "TEAM_ASSIGNMENT_UPDATED", teamId, {
      franchiseId,
      franchiseName: franchise.rows[0].name,
    });
    return {
      team_id: teamId,
      franchise_id: franchiseId,
      franchise_name: franchise.rows[0].name,
      assignment_status: "ASSIGNED",
    };
  });

export const lockAssignments = async ({ actorId }) =>
  withTransaction(async (client) => {
    const incomplete = await client.query(
      `SELECT COUNT(*)::int AS count FROM college_teams ct
       LEFT JOIN secret_assignments sa ON sa.team_id = ct.id
       WHERE ct.status = 'ACTIVE' AND sa.team_id IS NULL`,
    );
    if (incomplete.rows[0].count > 0) {
      throw new Error("Assign every active team before locking assignments");
    }
    const revealed = await client.query(
      "SELECT COUNT(*)::int AS count FROM secret_assignments WHERE status = 'REVEALED'",
    );
    if (revealed.rows[0].count > 0) {
      throw new Error("Revealed assignments cannot be locked again");
    }
    const locked = await client.query(
      `UPDATE secret_assignments SET status = 'LOCKED', updated_at = NOW()
       WHERE status = 'ASSIGNED' RETURNING team_id`,
    );
    await recordAudit(client, actorId, "ASSIGNMENTS_LOCKED", null, {
      locked: locked.rowCount,
    });
    return { locked: locked.rowCount };
  });

export const revealAssignments = async ({ actorId, teamId = null }) =>
  withTransaction(async (client) => {
    let revealed;
    if (teamId) {
      revealed = await client.query(
        `UPDATE secret_assignments SET status = 'REVEALED', revealed_at = NOW(), updated_at = NOW()
         WHERE team_id = $1 AND status IN ('ASSIGNED', 'LOCKED') RETURNING team_id`,
        [teamId],
      );
      if (revealed.rowCount === 0) {
        throw new Error("Team has no unrevealed assignment");
      }
    } else {
      const incomplete = await client.query(
        `SELECT COUNT(*)::int AS count FROM college_teams ct
         LEFT JOIN secret_assignments sa ON sa.team_id = ct.id
         WHERE ct.status = 'ACTIVE' AND sa.team_id IS NULL`,
      );
      if (incomplete.rows[0].count > 0) {
        throw new Error("Assign every active team before revealing targets");
      }
      revealed = await client.query(
        `UPDATE secret_assignments SET status = 'REVEALED', revealed_at = NOW(), updated_at = NOW()
         WHERE status IN ('ASSIGNED', 'LOCKED') RETURNING team_id`,
      );
    }

    await recordAudit(
      client,
      actorId,
      teamId ? "ASSIGNMENT_REVEALED" : "ASSIGNMENTS_REVEALED",
      teamId,
      { revealed: revealed.rowCount },
    );
    return { revealed: revealed.rowCount };
  });

export const resetAssignments = async ({ actorId }) =>
  withTransaction(async (client) => {
    const deleted = await client.query(
      "DELETE FROM secret_assignments RETURNING team_id",
    );
    await client.query("DELETE FROM scores");
    await recordAudit(client, actorId, "ASSIGNMENTS_RESET", null, {
      removed: deleted.rowCount,
    });
    return { removed: deleted.rowCount };
  });

export const getParticipantAssignment = async (teamId) => {
  const result = await query(
    `SELECT sa.status, sa.revealed_at,
       CASE WHEN sa.status = 'REVEALED' THEN f.id END AS franchise_id,
       CASE WHEN sa.status = 'REVEALED' THEN f.name END AS franchise_name
     FROM secret_assignments sa
     JOIN ipl_franchises f ON f.id = sa.franchise_id
     WHERE sa.team_id = $1`,
    [teamId],
  );
  return (
    result.rows[0] || {
      status: "UNASSIGNED",
      franchise_id: null,
      franchise_name: null,
    }
  );
};

export const calculateScores = async ({ actorId }) =>
  withTransaction(async (client) => {
    await client.query(
      "SELECT id FROM college_teams WHERE status = 'ACTIVE' ORDER BY id FOR UPDATE",
    );
    const invalidRosters = await client.query(
      `SELECT ct.name, COUNT(s.player_id)::int AS squad_count,
         COUNT(s.player_id) FILTER (WHERE s.is_playing_xi)::int AS xi_count
       FROM college_teams ct
       LEFT JOIN squads s ON s.team_id = ct.id
       WHERE ct.status = 'ACTIVE'
       GROUP BY ct.id
       HAVING COUNT(s.player_id) NOT BETWEEN 11 AND 18
          OR COUNT(s.player_id) FILTER (WHERE s.is_playing_xi) <> 11`,
    );
    if (invalidRosters.rowCount > 0) {
      throw new Error(
        `Every team must have 11–18 players and fix exactly 11 for its playing XI: ${invalidRosters.rows.map((team) => team.name).join(", ")}`,
      );
    }

    const assignments = await client.query(
      `SELECT ct.id AS team_id, sa.franchise_id
       FROM college_teams ct
       JOIN secret_assignments sa ON sa.team_id = ct.id
       WHERE ct.status = 'ACTIVE' AND sa.status = 'REVEALED'
       ORDER BY ct.id`,
    );
    const assignedTeams = await client.query(
      "SELECT COUNT(*)::int AS count FROM college_teams WHERE status = 'ACTIVE'",
    );
    if (assignments.rowCount !== assignedTeams.rows[0].count) {
      throw new Error("Reveal all active team assignments before scoring");
    }

    const setting = await client.query(
      "SELECT value FROM game_settings WHERE key = 'scoring'",
    );
    const scoring = setting.rows[0]?.value || {};
    const basePoints = Number(scoring.target_player ?? 1);
    const captainBonus = Number(
      scoring.captain_bonus ?? Math.max(Number(scoring.captain ?? 2) - 1, 0),
    );
    const overseasBonus = Number(scoring.overseas ?? 1);
    const allRounderBonus = Number(scoring.all_rounder ?? 1);
    const results = [];

    for (const assignment of assignments.rows) {
      const squad = await client.query(
        `SELECT p.id, p.name, p.role, p.is_captain, p.is_overseas
         FROM squads s JOIN players p ON p.id = s.player_id
         WHERE s.team_id = $1 AND p.franchise_id = $2 AND s.is_playing_xi = TRUE
         ORDER BY p.name`,
        [assignment.team_id, assignment.franchise_id],
      );
      const matchingPlayers = squad.rows.map((player) => {
        const points =
          basePoints +
          (player.is_captain ? captainBonus : 0) +
          (player.is_overseas ? overseasBonus : 0) +
          (player.role === "ALL_ROUNDER" ? allRounderBonus : 0);
        return { ...player, points };
      });
      const totalScore = matchingPlayers.reduce(
        (total, player) => total + player.points,
        0,
      );
      const details = {
        matchingPlayerCount: matchingPlayers.length,
        captainMatches: matchingPlayers.filter((player) => player.is_captain)
          .length,
        overseasMatches: matchingPlayers.filter((player) => player.is_overseas)
          .length,
        allRounderMatches: matchingPlayers.filter(
          (player) => player.role === "ALL_ROUNDER",
        ).length,
        matchingPlayers,
      };
      await client.query(
        `INSERT INTO scores (team_id, total_score, details)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (team_id) DO UPDATE SET total_score = EXCLUDED.total_score,
           details = EXCLUDED.details, updated_at = NOW()`,
        [assignment.team_id, totalScore, JSON.stringify(details)],
      );
      results.push({ teamId: assignment.team_id, totalScore, details });
    }

    await client.query(
      "UPDATE college_teams SET playing_xi_locked = TRUE WHERE status = 'ACTIVE'",
    );

    await recordAudit(client, actorId, "SCORES_CALCULATED", null, {
      teams: results.length,
    });
    return results;
  });

export const getLeaderboard = async () => {
  const result = await query(
    `SELECT ct.id AS team_id, ct.name AS team_name, f.name AS franchise_name,
       s.total_score, s.details,
       COALESCE(json_agg(DISTINCT jsonb_build_object('name', tm.name, 'email', tm.email))
         FILTER (WHERE tm.id IS NOT NULL), '[]'::json) AS members
     FROM scores s
     JOIN college_teams ct ON ct.id = s.team_id
     JOIN secret_assignments sa ON sa.team_id = ct.id AND sa.status = 'REVEALED'
     JOIN ipl_franchises f ON f.id = sa.franchise_id
     LEFT JOIN team_members tm ON tm.team_id = ct.id
     GROUP BY ct.id, f.name, s.total_score, s.details
     ORDER BY s.total_score DESC, ct.name`,
  );
  return result.rows;
};

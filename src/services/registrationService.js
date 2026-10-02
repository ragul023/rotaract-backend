import { query, withTransaction } from "../database/connection.js";

export const getRegistrationSettings = async () => {
  const result = await query(
    "SELECT value FROM game_settings WHERE key = 'event_registration_fee'",
  );
  const fee = result.rowCount ? Number(result.rows[0].value) : null;
  return { fee: Number.isFinite(fee) && fee > 0 ? fee : null };
};

export const getTeamRegistration = async (userId) => {
  const result = await query(
    `SELECT ct.id, ct.name AS team_name, ct.registration_status, ct.status,
       CASE WHEN ct.registration_status = 'CONFIRMED' THEN ct.code END AS team_code,
       ct.leader_id = $1 AS is_captain, COUNT(tm.id)::int AS member_count,
       p.id AS payment_id, p.amount, p.currency, p.payment_status,
       p.payment_reference, p.created_at AS payment_created_at
     FROM college_teams ct
     JOIN team_members captain_member ON captain_member.team_id = ct.id
       AND captain_member.user_id = $1
     LEFT JOIN team_members tm ON tm.team_id = ct.id
     LEFT JOIN team_registration_payments p ON p.team_id = ct.id
     GROUP BY ct.id, p.id`,
    [userId],
  );
  return result.rows[0] || null;
};

export const setRegistrationFee = async (fee) => {
  const result = await query(
    `INSERT INTO game_settings (key, value)
     VALUES ('event_registration_fee', to_jsonb($1::numeric))
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
     RETURNING value`,
    [fee],
  );
  return { fee: Number(result.rows[0].value) };
};

export const getAdminRegistrations = async () => {
  const result = await query(
    `SELECT ct.id,
       CASE WHEN ct.registration_status = 'CONFIRMED' THEN ct.code END AS registration_code,
       ct.name AS team_name,
      ct.registration_status, ct.created_at, 'IPL AUCTION' AS event_name,
      leader.name AS captain_name,
      leader.email AS captain_email, leader.phone AS captain_phone,
      COUNT(DISTINCT m.id)::int AS team_size,
       p.amount, p.currency, p.payment_method, p.payment_reference,
       p.payment_status,
       COALESCE(json_agg(json_build_object(
         'name', m.name, 'registerNumber', m.register_number, 'email', m.email,
         'department', m.department, 'isCaptain', m.is_leader
       ) ORDER BY m.is_leader DESC, m.created_at) FILTER (WHERE m.id IS NOT NULL), '[]') AS members
     FROM college_teams ct
     JOIN users leader ON leader.id = ct.leader_id
     LEFT JOIN team_members m ON m.team_id = ct.id
     LEFT JOIN team_registration_payments p ON p.team_id = ct.id
     WHERE ct.registration_status <> 'CONFIRMED' OR p.id IS NOT NULL
     GROUP BY ct.id, leader.id, p.id
     ORDER BY ct.created_at DESC`,
  );
  return result.rows;
};

export const verifyRegistrationPayment = async ({
  teamId,
  adminId,
  approved,
}) =>
  withTransaction(async (client) => {
    const status = approved ? "PAID" : "REJECTED";
    const payment = await client.query(
      `UPDATE team_registration_payments
       SET payment_status = $2, verified_by = $3, verified_at = NOW()
       WHERE team_id = $1 AND payment_status = 'PENDING_VERIFICATION'
       RETURNING id`,
      [teamId, status, adminId],
    );
    if (payment.rowCount === 0) {
      throw new Error("No payment awaiting verification for this team");
    }
    await client.query(
      `UPDATE college_teams SET registration_status = $2,
         status = CASE WHEN $3 THEN 'ACTIVE' ELSE 'PENDING_PAYMENT' END,
         updated_at = NOW()
       WHERE id = $1`,
      [teamId, approved ? "CONFIRMED" : "PAYMENT_REJECTED", approved],
    );
    return {
      paymentStatus: status,
      registrationStatus: approved ? "CONFIRMED" : "PAYMENT_REJECTED",
    };
  });

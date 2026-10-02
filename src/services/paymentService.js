import { withTransaction } from "../database/connection.js";

export const createPaymentOrder = async (captainId) =>
  withTransaction(async (client) => {
    const team = await client.query(
      `SELECT id, registration_status FROM college_teams
       WHERE leader_id = $1 FOR UPDATE`,
      [captainId],
    );
    if (team.rowCount === 0) throw new Error("Create a team before payment");
    const teamId = team.rows[0].id;
    if (team.rows[0].registration_status === "CONFIRMED") {
      throw new Error("This team is already confirmed");
    }

    const existing = await client.query(
      "SELECT * FROM team_registration_payments WHERE team_id = $1",
      [teamId],
    );
    if (existing.rowCount) return existing.rows[0];

    const setting = await client.query(
      "SELECT value FROM game_settings WHERE key = 'event_registration_fee'",
    );
    const amount = setting.rowCount ? Number(setting.rows[0].value) : 0;
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("Registration fee has not been set by an administrator");
    }

    const payment = await client.query(
      `INSERT INTO team_registration_payments (team_id, captain_id, amount)
       VALUES ($1, $2, $3) RETURNING *`,
      [teamId, captainId, amount],
    );
    return payment.rows[0];
  });

export const submitUpiReference = async (captainId, paymentReference) =>
  withTransaction(async (client) => {
    const payment = await client.query(
      `SELECT p.id, p.team_id, p.payment_status, p.payment_reference
       FROM team_registration_payments p
       JOIN college_teams ct ON ct.id = p.team_id
       WHERE ct.leader_id = $1 FOR UPDATE OF p`,
      [captainId],
    );
    if (payment.rowCount === 0) throw new Error("Payment order not found");
    if (payment.rows[0].payment_status === "PAID") {
      throw new Error("This payment has already been verified");
    }
    if (
      payment.rows[0].payment_status === "PENDING_VERIFICATION" &&
      payment.rows[0].payment_reference !== paymentReference
    ) {
      throw new Error("Payment is awaiting admin verification");
    }

    const updated = await client.query(
      `UPDATE team_registration_payments
       SET payment_reference = $2, payment_status = 'PENDING_VERIFICATION',
           verified_by = NULL, verified_at = NULL
       WHERE id = $1 RETURNING *`,
      [payment.rows[0].id, paymentReference],
    );
    await client.query(
      `UPDATE college_teams SET registration_status = 'PENDING_PAYMENT',
         status = 'PENDING_PAYMENT', updated_at = NOW()
       WHERE id = $1`,
      [payment.rows[0].team_id],
    );
    return updated.rows[0];
  });

import bcrypt from "bcrypt";
import { v4 as uuidv4 } from "uuid";
import { pool, withTransaction } from "./connection.js";
import { env } from "../config/environment.js";

const franchiseNames = [
  "CSK",
  "MI",
  "RCB",
  "KKR",
  "SRH",
  "RR",
  "DC",
  "PBKS",
  "GT",
  "LSG",
];
const roles = ["BATTER", "BOWLER", "ALL_ROUNDER", "WICKET_KEEPER"];
const countries = [
  "India",
  "Australia",
  "England",
  "South Africa",
  "New Zealand",
  "Sri Lanka",
  "Pakistan",
];

const defaultPlayers = Array.from({ length: 120 }, (_, index) => {
  const name = `Player ${index + 1}`;
  const franchiseIndex = index % franchiseNames.length;
  const role = roles[index % roles.length];
  const country = countries[index % countries.length];
  return {
    id: uuidv4(),
    name,
    display_name: name,
    photo: `https://images.unsplash.com/photo-1546519638-68e109498ffc?auto=format&fit=crop&w=800&q=80`,
    country,
    role,
    base_price: 1 + (index % 12) * 0.5,
    is_overseas: index % 5 === 0,
    is_captain: index % 9 === 0,
    franchise: franchiseNames[franchiseIndex],
    status: "AVAILABLE",
  };
});

async function seed() {
  await withTransaction(async (client) => {
    const teamList = [
      {
        email: env.SUPER_ADMIN_EMAIL,
        password: env.SUPER_ADMIN_PASSWORD,
        role: "SUPER_ADMIN",
        name: "Super Admin",
      },
      {
        email: env.AUCTION_ADMIN_EMAIL,
        password: env.AUCTION_ADMIN_PASSWORD,
        role: "AUCTION_ADMIN",
        name: "Auction Admin",
      },
    ];

    for (const user of teamList) {
      const exists = await client.query(
        "SELECT id FROM users WHERE email = $1",
        [user.email],
      );
      if (exists.rowCount === 0) {
        const hash = await bcrypt.hash(user.password, 10);
        await client.query(
          `INSERT INTO users (id, email, password_hash, role, name) VALUES ($1, $2, $3, $4, $5)`,
          [uuidv4(), user.email, hash, user.role, user.name],
        );
      }
    }

    for (const name of franchiseNames) {
      const shortName = name;
      const exists = await client.query(
        "SELECT id FROM ipl_franchises WHERE short_name = $1",
        [shortName],
      );
      if (exists.rowCount === 0) {
        await client.query(
          "INSERT INTO ipl_franchises (id, name, short_name, is_active) VALUES ($1, $2, $3, true)",
          [uuidv4(), name, shortName],
        );
      }
    }

    const franchiseRows = await client.query("SELECT * FROM ipl_franchises");
    const franchiseMap = new Map(
      franchiseRows.rows.map((row) => [row.short_name, row.id]),
    );

    for (const player of defaultPlayers) {
      const exists = await client.query(
        "SELECT id FROM players WHERE name = $1",
        [player.name],
      );
      if (exists.rowCount === 0) {
        await client.query(
          `INSERT INTO players (id, name, display_name, photo, country, role, base_price, is_overseas, is_captain, franchise_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            player.id,
            player.name,
            player.display_name,
            player.photo,
            player.country,
            player.role,
            player.base_price,
            player.is_overseas,
            player.is_captain,
            franchiseMap.get(player.franchise),
            player.status,
          ],
        );
      }
    }

    const settings = [
      { key: "initial_timer_seconds", value: 30 },
      { key: "bid_increment", value: 1 },
      { key: "max_team_members", value: 5 },
      { key: "auction_reveal_after_players", value: 0 },
      {
        key: "scoring",
        value: {
          captain: 2,
          overseas: 1,
          all_rounder: 1,
          batter: 1,
          wicket_keeper: 1,
        },
      },
      { key: "trade_window_open", value: false },
      { key: "event_registration_fee", value: null },
    ];

    for (const setting of settings) {
      const exists = await client.query(
        "SELECT id FROM game_settings WHERE key = $1",
        [setting.key],
      );
      if (exists.rowCount === 0) {
        await client.query(
          "INSERT INTO game_settings (id, key, value) VALUES ($1, $2, $3)",
          [uuidv4(), setting.key, JSON.stringify(setting.value)],
        );
      }
    }

    const auctionExists = await client.query("SELECT id FROM auction LIMIT 1");
    if (auctionExists.rowCount === 0) {
      const timerSetting = await client.query(
        "SELECT value FROM game_settings WHERE key = 'initial_timer_seconds'",
      );
      const configuredTimer = Number(timerSetting.rows[0]?.value ?? 30);
      const timerSeconds =
        Number.isInteger(configuredTimer) &&
        configuredTimer >= 5 &&
        configuredTimer <= 600
          ? configuredTimer
          : 30;
      await client.query(
        `INSERT INTO auction (id, status, current_bid, bid_increment, timer_seconds, bid_ends_at)
         VALUES ($1, 'LOBBY', 0, 1, $2, NOW())`,
        [uuidv4(), timerSeconds],
      );
    }
  });

  console.log("Database seeded successfully.");
  process.exit(0);
}

seed().catch((error) => {
  console.error("Seeding failed:", error.message);
  process.exit(1);
});

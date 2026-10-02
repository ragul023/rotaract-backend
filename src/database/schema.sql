CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('SUPER_ADMIN', 'AUCTION_ADMIN', 'PARTICIPANT', 'VIEWER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE auction_status AS ENUM (
    'LOBBY',
    'AUCTION_STARTING',
    'PLAYER_PRESENTED',
    'BIDDING',
    'PLAYER_SOLD',
    'PLAYER_UNSOLD',
    'NEXT_PLAYER',
    'AUCTION_PAUSED',
    'AUCTION_COMPLETED',
    'REVEAL',
    'SCORING',
    'FINISHED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE player_role AS ENUM ('BATTER', 'BOWLER', 'ALL_ROUNDER', 'WICKET_KEEPER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE assignment_status AS ENUM ('UNASSIGNED', 'ASSIGNED', 'REVEALED', 'LOCKED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role user_role NOT NULL DEFAULT 'PARTICIPANT',
  name VARCHAR(255) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS college_teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  code VARCHAR(50) UNIQUE NOT NULL,
  leader_id UUID REFERENCES users(id) ON DELETE CASCADE,
  purse NUMERIC(10,2) NOT NULL DEFAULT 90.00,
  spent NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
  playing_xi_locked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE college_teams
  ADD COLUMN IF NOT EXISTS registration_status VARCHAR(30) NOT NULL DEFAULT 'CONFIRMED'
  CHECK (registration_status IN ('PENDING_PAYMENT', 'CONFIRMED', 'PAYMENT_REJECTED'));
ALTER TABLE college_teams
  ADD COLUMN IF NOT EXISTS playing_xi_locked BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES college_teams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  register_number VARCHAR(255) NOT NULL,
  department VARCHAR(255) NOT NULL,
  is_leader BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(team_id, email),
  UNIQUE(team_id, register_number)
);

CREATE TABLE IF NOT EXISTS team_registration_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL UNIQUE REFERENCES college_teams(id) ON DELETE CASCADE,
  captain_id UUID NOT NULL REFERENCES users(id),
  amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  payment_method VARCHAR(30) NOT NULL DEFAULT 'UPI_MANUAL',
  payment_reference VARCHAR(255),
  payment_status VARCHAR(30) NOT NULL DEFAULT 'PENDING'
    CHECK (payment_status IN ('PENDING', 'PENDING_VERIFICATION', 'PAID', 'REJECTED')),
  verified_by UUID REFERENCES users(id),
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ipl_franchises (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) UNIQUE NOT NULL,
  short_name VARCHAR(10) UNIQUE NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  display_name VARCHAR(255),
  photo TEXT,
  country VARCHAR(255) NOT NULL,
  role player_role NOT NULL,
  base_price NUMERIC(10,2) NOT NULL,
  is_overseas BOOLEAN NOT NULL DEFAULT FALSE,
  is_captain BOOLEAN NOT NULL DEFAULT FALSE,
  franchise_id UUID REFERENCES ipl_franchises(id),
  status VARCHAR(50) NOT NULL DEFAULT 'AVAILABLE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS game_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(255) UNIQUE NOT NULL,
  value JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auction (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status auction_status NOT NULL DEFAULT 'LOBBY',
  current_player_id UUID REFERENCES players(id),
  current_bid NUMERIC(10,2) NOT NULL DEFAULT 0,
  highest_bidder_team_id UUID REFERENCES college_teams(id),
  bid_increment NUMERIC(10,2) NOT NULL DEFAULT 1.00,
  current_sequence INTEGER NOT NULL DEFAULT 0,
  auction_started_at TIMESTAMPTZ,
  auction_completed_at TIMESTAMPTZ,
  reveal_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  reveal_after_players INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE auction
  DROP COLUMN IF EXISTS timer_seconds,
  DROP COLUMN IF EXISTS bid_ends_at;
DELETE FROM game_settings WHERE key = 'initial_timer_seconds';

CREATE TABLE IF NOT EXISTS auction_players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id UUID NOT NULL REFERENCES auction(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  order_index INTEGER NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  sold_team_id UUID REFERENCES college_teams(id),
  sold_price NUMERIC(10,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(auction_id, player_id)
);

CREATE TABLE IF NOT EXISTS bids (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id UUID NOT NULL REFERENCES auction(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id),
  team_id UUID NOT NULL REFERENCES college_teams(id),
  amount NUMERIC(10,2) NOT NULL,
  sequence_number INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL UNIQUE REFERENCES college_teams(id) ON DELETE CASCADE,
  available_purse NUMERIC(10,2) NOT NULL DEFAULT 90.00,
  spent_purse NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  bonus_purse NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS squads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES college_teams(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  acquired_price NUMERIC(10,2) NOT NULL,
  is_playing_xi BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(team_id, player_id)
);
ALTER TABLE squads
  ADD COLUMN IF NOT EXISTS is_playing_xi BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS trade_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_team_id UUID NOT NULL REFERENCES college_teams(id) ON DELETE CASCADE,
  to_team_id UUID NOT NULL REFERENCES college_teams(id) ON DELETE CASCADE,
  offered_player_id UUID NOT NULL REFERENCES players(id),
  requested_player_id UUID NOT NULL REFERENCES players(id),
  cash_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (cash_amount >= 0),
  buyer_acknowledged_at TIMESTAMPTZ DEFAULT NOW(),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (from_team_id <> to_team_id),
  CHECK (offered_player_id <> requested_player_id)
);
ALTER TABLE trade_offers
  ADD COLUMN IF NOT EXISTS cash_amount NUMERIC(10,2) NOT NULL DEFAULT 0
  CHECK (cash_amount >= 0);
ALTER TABLE trade_offers
  ADD COLUMN IF NOT EXISTS buyer_acknowledged_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE trade_offers
  ALTER COLUMN buyer_acknowledged_at SET DEFAULT NOW();

CREATE TABLE IF NOT EXISTS player_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_team_id UUID NOT NULL REFERENCES college_teams(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id),
  asking_price NUMERIC(10,2) NOT NULL CHECK (asking_price > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'SOLD', 'CANCELLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS player_listings_one_open_per_player
  ON player_listings(player_id) WHERE status = 'OPEN';

CREATE TABLE IF NOT EXISTS player_purchase_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES player_listings(id) ON DELETE CASCADE,
  buyer_team_id UUID NOT NULL REFERENCES college_teams(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED')),
  buyer_acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS player_purchase_requests_one_pending
  ON player_purchase_requests(listing_id, buyer_team_id)
  WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS player_purchase_requests_buyer_queue
  ON player_purchase_requests(buyer_team_id, buyer_acknowledged_at, created_at);

CREATE TABLE IF NOT EXISTS team_power_uses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id UUID NOT NULL REFERENCES auction(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES college_teams(id) ON DELETE CASCADE,
  power_key VARCHAR(40) NOT NULL,
  player_id UUID REFERENCES players(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (auction_id, team_id, power_key)
);
DELETE FROM team_power_uses WHERE power_key = 'TACTICAL_TIMEOUT';

CREATE TABLE IF NOT EXISTS secret_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL UNIQUE REFERENCES college_teams(id) ON DELETE CASCADE,
  franchise_id UUID NOT NULL REFERENCES ipl_franchises(id),
  status assignment_status NOT NULL DEFAULT 'UNASSIGNED',
  revealed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES college_teams(id) ON DELETE CASCADE,
  total_score INTEGER NOT NULL DEFAULT 0,
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auction_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES users(id),
  actor_team_id UUID REFERENCES college_teams(id),
  action VARCHAR(255) NOT NULL,
  target VARCHAR(255),
  old_value JSONB,
  new_value JSONB,
  reason TEXT,
  ip_address VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS random_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  config JSONB NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  probability NUMERIC(5,2) NOT NULL DEFAULT 0.00,
  duration_seconds INTEGER NOT NULL DEFAULT 30,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_team_members_team_id ON team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_players_role ON players(role);
CREATE INDEX IF NOT EXISTS idx_players_franchise ON players(franchise_id);
CREATE INDEX IF NOT EXISTS idx_bids_player ON bids(player_id);
CREATE INDEX IF NOT EXISTS idx_bids_team ON bids(team_id);
CREATE INDEX IF NOT EXISTS idx_auction_current_player ON auction(current_player_id);
CREATE INDEX IF NOT EXISTS idx_secret_assignments_team ON secret_assignments(team_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scores_team_unique ON scores(team_id);
CREATE INDEX IF NOT EXISTS idx_trade_offers_recipient ON trade_offers(to_team_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trade_offers_sender ON trade_offers(from_team_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_team_power_uses_team ON team_power_uses(team_id, auction_id);

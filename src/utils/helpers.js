export const randomCode = (prefix = "TEAM") => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${prefix}-${code}`;
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const formatMoney = (value) => `₹${Number(value || 0).toFixed(2)} Cr`;

export const safeNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

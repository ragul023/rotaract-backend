export const successResponse = (res, payload, status = 200) => {
  return res.status(status).json({ success: true, ...payload });
};

export const errorResponse = (
  res,
  message,
  status = 400,
  code = "BAD_REQUEST",
) => {
  return res.status(status).json({ success: false, message, code });
};

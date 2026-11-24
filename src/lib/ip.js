function normalizeIp(raw) {
  if (!raw) return null;
  let value = String(raw).trim();
  if (value.startsWith("[")) value = value.slice(1, value.indexOf("]"));
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped) return mapped[1];
  if (value === "::1") return "127.0.0.1";
  return value.toLowerCase();
}

function clientIp(req, trustProxyHops) {
  const socketIp = normalizeIp(req.socket?.remoteAddress);
  if (trustProxyHops <= 0) return socketIp;

  const chain = String(req.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map((entry) => normalizeIp(entry))
    .filter(Boolean);

  if (chain.length === 0) return socketIp;
  const index = chain.length - trustProxyHops;
  return chain[Math.max(0, index)] ?? socketIp;
}

function ipFingerprint(ip, mode) {
  if (!ip) return null;
  if (mode === "strict") return ip;

  if (ip.includes(":")) {
    const groups = ip.split(":");
    return `${groups.slice(0, 4).join(":")}::/64`;
  }

  const octets = ip.split(".");
  if (octets.length !== 4) return ip;
  return `${octets.slice(0, 3).join(".")}.0/24`;
}

function ipMatches(storedFingerprint, candidateIp, mode) {
  if (!storedFingerprint) return true;
  return storedFingerprint === ipFingerprint(candidateIp, mode);
}

export { clientIp, ipFingerprint, ipMatches, normalizeIp };

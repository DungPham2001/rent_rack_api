require('dotenv').config();

const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const env = process.env.NODE_ENV || 'development';

const jwtSecret = process.env.JWT_SECRET || (env === 'production' ? '' : 'rentrack-dev-only-secret-do-not-use-in-production');
if (!jwtSecret || (env === 'production' && jwtSecret.length < 32)) {
  throw new Error('JWT_SECRET (>= 32 chars) is required in production');
}

module.exports = {
  env,
  isTest: env === 'test',
  port: num(process.env.PORT, 4000),
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/rentrack',
  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  /** Fallback timezone; each shop has its own `rules.timezone`. */
  timezone: process.env.TIMEZONE || 'Asia/Ho_Chi_Minh',
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),

  apiVersion: '1.0.0',
  minAppVersion: process.env.MIN_APP_VERSION || '1.0.0',
  latestAppVersion: process.env.LATEST_APP_VERSION || process.env.MIN_APP_VERSION || '1.0.0',

  jwt: { secret: jwtSecret, issuer: 'rentrack-api', audience: 'rentrack-app' },
  session: {
    accessTtlSec: num(process.env.ACCESS_TOKEN_MINUTES, 120) * 60, // 2 h (spec 2.3)
    refreshIdleSec: num(process.env.REFRESH_IDLE_MINUTES, 180) * 60, // not remembered: sliding 3 h
    maxAgeSec: num(process.env.SESSION_MAX_HOURS, 12) * 3600, // not remembered: absolute 12 h
    rememberIdleSec: num(process.env.REMEMBER_IDLE_DAYS, 30) * 86400, // "Ghi nhớ": 30 days without use (sliding)
    rememberMaxSec: num(process.env.REMEMBER_MAX_DAYS, 365) * 86400,
    maxPerAccount: num(process.env.MAX_SESSIONS_PER_ACCOUNT, 10),
  },
  bcryptRounds: env === 'test' ? 4 : 10,
  resetCodeSec: num(process.env.RESET_CODE_MINUTES, 30) * 60,

  smtp: {
    host: env === 'test' ? '' : process.env.SMTP_HOST || '',
    port: num(process.env.SMTP_PORT, 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'RentRack <no-reply@example.com>',
  },

  cronSecret: process.env.CRON_SECRET || '',

  rate: {
    enabled: process.env.RATE_LIMIT !== 'off' && env !== 'test',
    readPerMin: num(process.env.RATE_READ_PER_MIN, 240),
    writePerMin: num(process.env.RATE_WRITE_PER_MIN, 90),
    authPerMin: num(process.env.RATE_AUTH_PER_MIN, 10),
    registerPerHour: num(process.env.RATE_REGISTER_PER_HOUR, 5),
    banAfterViolations: num(process.env.RATE_BAN_AFTER, 30),
    banMinutes: num(process.env.RATE_BAN_MINUTES, 15),
  },
  // spec 2.3: 5 consecutive failures lock that email for 5 minutes
  login: { maxFailures: num(process.env.LOGIN_MAX_FAILURES, 5), lockSec: num(process.env.LOGIN_LOCK_MINUTES, 5) * 60 },
};

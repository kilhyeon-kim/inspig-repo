import { registerAs } from '@nestjs/config';

/**
 * 데이터베이스 설정
 *
 * Connection Pool 설정:
 * - poolPingInterval: 연결 유효성 검사 주기 (초)
 *   → DB 서버 재시작 시 끊어진 연결 자동 감지/제거
 * - poolTimeout: 유휴 연결 타임아웃 (초)
 * - poolMin/poolMax: 커넥션 풀 크기
 */
export default registerAs('database', () => ({
  type: 'oracle' as const,
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '1521', 10),
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  serviceName: process.env.DB_SERVICE_NAME,
  synchronize: false,
  logging: process.env.NODE_ENV !== 'production',
  // Connection Pool 설정 (Stale Connection 방지)
  extra: {
    poolMin: 2, // 최소 연결 수
    poolMax: 10, // 최대 연결 수
    poolTimeout: 60, // 유휴 연결 타임아웃 (초)
    poolPingInterval: 60, // 연결 유효성 검사 주기 (초) - 핵심 설정
    stmtCacheSize: 30, // Statement 캐시 크기
    queueTimeout: 60000, // 연결 대기 타임아웃 (ms)
  },
}));

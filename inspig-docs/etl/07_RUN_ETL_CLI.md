# ETL CLI 명령어 레퍼런스

> `run_etl.py` 명령어 전체 참조 문서

---

## 1. 기본 사용법

```bash
python run_etl.py [command] [options]
```

| 명령 | 설명 | 대상 농장 |
|------|------|----------|
| `all` | 전체 ETL (생산성 + 주간리포트) | 서비스 농장 |
| `weekly` | 주간 리포트 ETL | 서비스 농장 |
| `monthly` | 월간 리포트 ETL (예정) | 서비스 농장 |
| `quarterly` | 분기 리포트 ETL (예정) | 서비스 농장 |
| `weather` | 기상청 데이터 수집 | 서비스 농장 지역 |
| `productivity` | 생산성 데이터 수집 | 서비스 농장 |
| `productivity-all` | 전체 농장 생산성 수집 | 전체 농장 (서비스+일반) |

> **농장 유형 정의**: [06_PRODUCTIVITY_COLLECT.md](./06_PRODUCTIVITY_COLLECT.md#12-농장-유형-정의) 참조

---

## 2. 생산성 데이터 수집

### 2.1 productivity-all (전체 농장)

**승인회원 보유 전체 농장** (서비스 농장 + 일반 농장) 대상. 서비스 농장 우선 수집.

> **API 호출 정보**: [06_PRODUCTIVITY_COLLECT.md](./06_PRODUCTIVITY_COLLECT.md#13-api-호출-정보) 참조

```bash
# 주간 생산성 (기본값: W)
python run_etl.py productivity-all

# 주간 생산성 (명시적)
python run_etl.py productivity-all --period W

# 월간 생산성
python run_etl.py productivity-all --period M

# 분기 생산성
python run_etl.py productivity-all --period Q

# 특정 날짜 기준
python run_etl.py productivity-all --period W --base-date 2025-01-20

# 특정 농장 제외
python run_etl.py productivity-all --exclude-farms "848,1234"

# Dry-run (실제 저장 없이 확인)
python run_etl.py productivity-all --dry-run
```

**Cron 스케줄** (서버: UTC):

| 기간 | Cron (UTC) | KST 실행 | 명령 |
|------|------------|----------|------|
| 주간 | `5 15 * * 0` | 월 00:05 | `./run_productivity_all.sh W` |
| 월간 | `5 15 28-31 * *` | 1일 00:05 | `./run_productivity_all.sh M` |

### 2.2 productivity (서비스 농장)

**InsightPig 서비스 농장**만 대상 (REG_TYPE='AUTO').

```bash
# 주간 생산성 (현재 날짜 기준)
python run_etl.py productivity

# 특정 날짜 기준
python run_etl.py productivity --base-date 2025-01-20

# 월간 생산성
python run_etl.py productivity --period M --base-date 2025-01-20

# 분기 생산성
python run_etl.py productivity --period Q --base-date 2025-01-20

# 테스트 모드 (특정 농장만)
python run_etl.py productivity --test --farm-list "1387,2807"

# 특정 농장 제외
python run_etl.py productivity --exclude-farms "848,1234"
```

---

## 3. 기상청 데이터 수집

### 3.1 weather

서비스 농장 지역의 ASOS 관측 데이터 수집.

```bash
# 기상청 데이터 수집 (현재 시간 기준)
python run_etl.py weather

# Dry-run
python run_etl.py weather --dry-run
```

**Cron 스케줄**:

| 주기 | Cron (UTC) | KST 실행 | 설명 |
|------|------------|----------|------|
| 매시 | `0 * * * *` | 매시 정각 | ASOS 시간별 관측 |
| 일별 | `30 15 * * *` | 00:30 | ASOS 일별 통계 |

---

## 4. 주간 리포트 ETL

### 4.1 weekly

InsightPig 서비스 농장 대상 주간 리포트 생성.

```bash
# 주간 리포트 ETL (전체 농장)
python run_etl.py weekly

# 스케줄 그룹별 실행
python run_etl.py weekly --schedule-group AM7   # 오전 7시 알림 농장
python run_etl.py weekly --schedule-group PM2   # 오후 2시 알림 농장

# 테스트 모드
python run_etl.py weekly --test

# 특정 날짜 기준
python run_etl.py weekly --base-date 2025-01-20

# 특정 농장만 실행
python run_etl.py weekly --test --farm-list "1387,2807"

# 특정 농장 제외
python run_etl.py weekly --exclude "848,1234"

# Dry-run
python run_etl.py weekly --dry-run
```

**Cron 스케줄** (서버: UTC):

| 그룹 | Cron (UTC) | KST 실행 | 알림 발송 |
|------|------------|----------|----------|
| AM7 | `0 17 * * 0` | 월 02:00 | 07:00 |
| PM2 | `0 3 * * 1` | 월 12:00 | 14:00 |

### 4.2 all (전체 ETL)

생산성 수집 + 주간 리포트를 순차 실행.

```bash
# 전체 ETL
python run_etl.py all

# 테스트 모드
python run_etl.py all --test
```

---

## 5. 수동 실행 모드

웹시스템에서 특정 농장 ETL 호출 시 사용.

```bash
# 특정 농장 수동 실행
python run_etl.py --manual --farm-no 12345

# 특정 기간 지정
python run_etl.py --manual --farm-no 12345 --dt-from 20251215 --dt-to 20251221
```

---

## 6. 공통 옵션

| 옵션 | 설명 | 예시 |
|------|------|------|
| `--dry-run` | 설정 확인만 (실제 실행 안함) | `--dry-run` |
| `--test` | 테스트 모드 | `--test` |
| `--base-date` | 기준 날짜 (YYYY-MM-DD) | `--base-date 2025-01-20` |
| `--farm-list` | 특정 농장만 실행 (콤마 구분) | `--farm-list "1387,2807"` |
| `--exclude` | 제외 농장 (콤마 구분) | `--exclude "848,1234"` |
| `--exclude-farms` | 제외 농장 (콤마 구분) | `--exclude-farms "848,1234"` |
| `--period` | 기간구분 (W/M/Q) | `--period M` |
| `--schedule-group` | 스케줄 그룹 (AM7/PM2) | `--schedule-group AM7` |
| `--day-gb` | 리포트 종류 (WEEK/MONTH/QUARTER) | `--day-gb WEEK` |

### 6.1 초기화 옵션 (테스트용)

| 옵션 | 설명 |
|------|------|
| `--init-week` | 해당 주차 데이터만 삭제 후 실행 |
| `--init-all` | 전체 테스트 데이터 삭제 후 실행 |

```bash
# 해당 주차 데이터 삭제 후 테스트
python run_etl.py --test --init-week

# 전체 데이터 삭제 후 테스트
python run_etl.py --test --init-all
```

---

## 7. Shell 스크립트

### 7.1 run_weekly.sh

```bash
# 주간 ETL (전체 농장)
./run_weekly.sh

# 스케줄 그룹별
./run_weekly.sh AM7
./run_weekly.sh PM2
```

### 7.2 run_productivity_all.sh

```bash
# 주간 생산성
./run_productivity_all.sh W

# 월간 생산성
./run_productivity_all.sh M

# 분기 생산성
./run_productivity_all.sh Q
```

---

## 관련 문서

- [01_ETL_OVERVIEW.md](./01_ETL_OVERVIEW.md) - ETL 시스템 개요
- [05_OPERATION_GUIDE.md](./05_OPERATION_GUIDE.md) - 운영 가이드
- [06_PRODUCTIVITY_COLLECT.md](./06_PRODUCTIVITY_COLLECT.md) - 생산성 수집 상세

## 관련 소스

- [run_etl.py](../../inspig-etl/run_etl.py) - 메인 실행 스크립트
- [run_weekly.sh](../../inspig-etl/run_weekly.sh) - 주간 ETL 쉘 스크립트
- [run_productivity_all.sh](../../inspig-etl/run_productivity_all.sh) - 생산성 수집 쉘 스크립트

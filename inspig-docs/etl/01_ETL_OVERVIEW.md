# InsightPig ETL 시스템 개요

## 1. 프로젝트 개요

InsightPig ETL은 양돈 농장의 생산 데이터를 집계하여 리포트를 생성하는 배치 시스템입니다.
기존 Oracle Stored Procedure 기반 시스템을 Python으로 전환하여 유지보수성과 확장성을 개선하였습니다.

### 1.1 목적
- 농장별 생산 데이터 집계 및 리포트 생성 (주간/월간/분기)
- 기상청/생산성 외부 API 데이터 수집
- 웹시스템에서 조회할 수 있는 리포트 데이터 제공

### 1.2 리포트 종류

| 종류 | DAY_GB | 실행 주기 | 설명 |
|------|--------|----------|------|
| **주간 리포트** | WEEK | 매주 월요일 새벽 2시 | 지난주 데이터 집계 |
| 월간 리포트 | MON | 매월 1일 새벽 3시 | 지난달 데이터 집계 (예정) |
| 분기 리포트 | QT | 분기 첫날 새벽 4시 | 지난 분기 데이터 집계 (예정) |


## 2. 시스템 아키텍처

```
┌─────────────────────────────────────────────────────────────────┐
│                       InsightPig ETL                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │   run_etl.py │───▶│ Orchestrator │───▶│  Collectors  │      │
│  │   (Entry)    │    │              │    │  - Weather   │      │
│  └──────────────┘    │              │    │  - Product.  │      │
│                      └──────┬───────┘    └──────────────┘      │
│                             │                                   │
│           ┌─────────────────┼─────────────────┐                │
│           ▼                 ▼                 ▼                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │ 주간 리포트   │  │ 월간 리포트   │  │ 분기 리포트   │         │
│  │ (WEEK)       │  │ (MON)        │  │ (QT)         │         │
│  └──────┬───────┘  └──────────────┘  └──────────────┘         │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────────────────────────────────────────┐          │
│  │                  FarmProcessor                    │          │
│  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐    │          │
│  │  │ Mating │ │Farrow- │ │Weaning │ │Culling │... │          │
│  │  │        │ │  ing   │ │        │ │        │    │          │
│  │  └────────┘ └────────┘ └────────┘ └────────┘    │          │
│  └──────────────────────────────────────────────────┘          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │  Oracle Database │
                    │  TS_INS_MASTER   │
                    │  TS_INS_WEEK     │
                    │  TS_INS_WEEK_SUB │
                    └──────────────────┘
```


## 3. 디렉토리 구조

```
inspig-etl/
├── run_etl.py              # 메인 실행 스크립트
├── config.ini              # 설정 파일 (git 제외)
├── config.ini.example      # 설정 파일 템플릿
├── run_weekly.sh           # Crontab 실행 스크립트
├── deploy-etl.sh           # 운영 서버 배포 스크립트
├── requirements.txt        # Python 의존성
│
├── docs/                   # 문서
│   ├── 01_ETL_OVERVIEW.md      # 전체 개요 (본 문서)
│   ├── 02_WEEKLY_REPORT.md     # 주간 리포트 상세
│   ├── 03_MONTHLY_REPORT.md    # 월간 리포트 상세 (예정)
│   ├── 04_QUARTERLY_REPORT.md  # 분기 리포트 상세 (예정)
│   └── 05_OPERATION_GUIDE.md   # 운영 가이드
│
├── src/
│   ├── common/             # 공통 모듈
│   │   ├── config.py           # 설정 관리
│   │   ├── database.py         # DB 연결
│   │   └── logger.py           # 로깅
│   │
│   ├── collectors/         # 외부 데이터 수집
│   │   ├── base.py             # 수집기 기본 클래스
│   │   ├── weather.py          # 기상청 API
│   │   └── productivity.py     # 생산성 API
│   │
│   └── weekly/             # 주간 리포트
│       ├── orchestrator.py     # 오케스트레이터
│       ├── farm_processor.py   # 농장별 처리
│       ├── async_processor.py  # 비동기 병렬 처리
│       ├── data_loader.py      # 데이터 로더
│       └── processors/         # 프로세서들
│
└── logs/                   # 로그 파일
```


## 4. 설정 (config.ini)

```ini
[database]
# Oracle RDS 접속 정보
user = pksu
password = YOUR_PASSWORD_HERE
dsn = pigclouddb.c8ks4denaq5l.ap-northeast-2.rds.amazonaws.com:1521/pigplan

[processing]
# 병렬 처리 스레드 수
parallel = 4
max_farm_workers = 4
max_processor_workers = 5
test_mode = N

[logging]
log_path = /data/etl/inspig/logs

[api]
productivity_base_url = http://10.4.35.10:11000
productivity_timeout = 60

[weather]
api_key = YOUR_WEATHER_API_KEY
base_url = https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0
```


## 5. 데이터베이스 테이블

### 5.1 주요 테이블

| 테이블 | 용도 |
|--------|------|
| TS_INS_SERVICE | 서비스 신청 농장 관리 (REG_TYPE: AUTO/MANUAL) |
| TS_INS_MASTER | 배치 실행 마스터 |
| TS_INS_WEEK | 농장별 리포트 헤더 |
| TS_INS_WEEK_SUB | 농장별 리포트 상세 |
| TS_INS_JOB_LOG | 작업 로그 |

### 5.2 REG_TYPE 구분

| 값 | 설명 |
|----|------|
| AUTO | 정기 스케줄 대상 |
| MANUAL | 수동 등록 (스케줄 제외) |

> REG_TYPE과 무관하게 `/batch/manual` API를 통해 수동 ETL 실행 가능


## 6. 빠른 시작

### 6.1 로컬 개발 환경

```bash
cd C:\Projects\inspig-etl

# Conda 환경 생성 (최초 1회)
conda create -n inspig-etl python=3.8
conda activate inspig-etl

# 의존성 설치
pip install oracledb requests python-dotenv

# 설정 파일 생성
cp config.ini.example config.ini
# config.ini 편집하여 DB 정보 입력

# 테스트 실행 (dry-run)
python run_etl.py --dry-run
```

### 6.2 기본 실행

```bash
# 전체 ETL 실행
python run_etl.py

# 주간 리포트만
python run_etl.py weekly

# 기상청 데이터만
python run_etl.py weather

# 전체 농장 생산성 수집
python run_etl.py productivity-all

# 특정 농장 수동 실행
python run_etl.py --manual --farm-no 12345
```

> 전체 CLI 명령어는 [07_CLI_REFERENCE.md](./07_CLI_REFERENCE.md) 참조


## 7. 운영 서버 정보

| 항목 | 값 |
|------|-----|
| 서버 | 10.4.35.10 |
| 사용자 | pigplan |
| Python | 3.8.5 (Anaconda) |
| 경로 | /data/etl/inspig |
| Conda 환경 | inspig-etl |


## 8. Crontab 스케줄

> **참고**: 운영 서버는 UTC 시간대입니다. KST = UTC + 9시간

### 8.1 전체 스케줄 요약

| 작업 | Cron (UTC) | KST 실행 시각 | 스크립트 | 명령 |
|------|------------|--------------|----------|------|
| **생산성 주간** | `5 15 * * 0` | 월 00:05 | run_productivity_all.sh | W |
| **생산성 월간** | `5 15 28-31 * *` | 1일 00:05 | run_productivity_all.sh | M |
| **주간 ETL AM7** | `0 17 * * 0` | 월 02:00 | run_weekly.sh | AM7 |
| **주간 ETL PM2** | `0 3 * * 1` | 월 12:00 | run_weekly.sh | PM2 |
| 기상청 매시 | `0 * * * *` | 매시 정각 | weather_etl.py | hourly |
| 기상청 일별 | `30 15 * * *` | 00:30 | weather_etl.py | daily |

### 8.2 Crontab 등록 예시

```bash
# ============================================================
# 생산성 데이터 수집 (전체 농장 대상, TS_PRODUCTIVITY)
# ============================================================
# 주간 (W): 매주 월요일 00:05 KST
5 15 * * 0 /data/etl/inspig/run_productivity_all.sh W

# 월간 (M): 매월 1일 00:05 KST (월말에 다음날이 1일인지 확인)
5 15 28-31 * * [ "$(date -d tomorrow +\%d)" = "01" ] && /data/etl/inspig/run_productivity_all.sh M

# ============================================================
# 주간 리포트 ETL (InsightPig 서비스 농장 대상)
# ============================================================
# AM7 그룹: 월요일 02:00 KST (07:00 알림 발송)
0 17 * * 0 /data/etl/inspig/run_weekly.sh AM7

# PM2 그룹: 월요일 12:00 KST (14:00 알림 발송)
0 3 * * 1 /data/etl/inspig/run_weekly.sh PM2

# ============================================================
# 기상청 데이터 수집
# ============================================================
# 매시 정각: ASOS 관측 데이터
0 * * * * cd /data/etl/inspig && /data/anaconda/anaconda3/envs/inspig-etl/bin/python weather_etl.py

# 매일 00:30 KST: ASOS 일별 통계
30 15 * * * cd /data/etl/inspig && /data/anaconda/anaconda3/envs/inspig-etl/bin/python weather_etl.py daily
```

### 8.3 수집 대상 구분

| ETL 종류 | 대상 농장 | 조회 함수 | 설명 |
|----------|----------|----------|------|
| 생산성 (productivity-all) | 승인 회원 있는 전체 농장 | `get_all_farm_nos()` | InsightPig 서비스 농장 우선 수집 |
| 주간 리포트 (weekly) | InsightPig 서비스 농장 | `get_service_farms()` | REG_TYPE='AUTO' 만 대상 |
| 기상청 (weather) | 서비스 농장 지역 | - | 시군구 코드 기준 |


## 9. 관련 문서

| 문서 | 설명 |
|------|------|
| [02_WEEKLY_REPORT.md](./02_WEEKLY_REPORT.md) | 주간 리포트 상세 (프로세서, 기술 구현) |
| [03_MONTHLY_REPORT.md](./03_MONTHLY_REPORT.md) | 월간 리포트 상세 (예정) |
| [04_QUARTERLY_REPORT.md](./04_QUARTERLY_REPORT.md) | 분기 리포트 상세 (예정) |
| [05_OPERATION_GUIDE.md](./05_OPERATION_GUIDE.md) | 운영 가이드 (실행, 모니터링, 트러블슈팅) |
| [06_PRODUCTIVITY_COLLECT.md](./06_PRODUCTIVITY_COLLECT.md) | 생산성 데이터 수집 (TS_PRODUCTIVITY) |
| [07_CLI_REFERENCE.md](./07_CLI_REFERENCE.md) | CLI 명령어 레퍼런스 |

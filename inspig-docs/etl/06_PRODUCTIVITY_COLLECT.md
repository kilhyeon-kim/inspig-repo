# 생산성 데이터 수집 (TS_PRODUCTIVITY)

> 외부 API(10.4.35.10:11000)에서 생산성 지표 수집 및 TS_PRODUCTIVITY 테이블 저장

---

## 1. 개요

| 항목 | 설명 |
|------|------|
| 대상 테이블 | TS_PRODUCTIVITY |
| 데이터 소스 | 10.4.35.10:11000 생산성 API |
| UK | FARM_NO + PCODE + STAT_YEAR + PERIOD + PERIOD_NO |
| 수집기 | `src/collectors/productivity.py` |

### 1.1 수집 시기

> **참고**: 운영 서버는 UTC 시간대입니다. KST = UTC + 9시간

| 명령 | Cron (UTC) | KST 실행 | 대상 농장 | 설명 |
|------|------------|----------|----------|------|
| `productivity-all W` | `5 15 * * 0` | 월 00:05 | 전체 농장 | 승인회원 있는 모든 농장 |
| `productivity-all M` | `5 15 28-31 * *` | 1일 00:05 | 전체 농장 | 월간 생산성 데이터 |
| `productivity` | - | 수동 | 서비스 농장 | InsightPig 서비스 농장만 |
| `weekly` | `0 17 * * 0` | 월 02:00 | 서비스 농장 | 주간 리포트 ETL 시 함께 수집 |

### 1.2 수집 대상

#### 1.2.1 productivity-all (전체 농장)

`productivity-all` 명령은 **승인된 회원이 있는 모든 농장**을 대상으로 합니다.

**조회 함수**: `get_all_farm_nos()` ([farm_service.py](../../inspig-etl/src/common/farm_service.py))

```sql
-- ALL_FARM_NO_SQL: 전체 농장번호 조회
SELECT DISTINCT FM.FARM_NO,
       CASE WHEN S.FARM_NO IS NOT NULL THEN 0 ELSE 1 END AS SORT_ORDER
FROM TA_FARM FM
LEFT JOIN VW_INS_SERVICE_ACTIVE S ON FM.FARM_NO = S.FARM_NO
WHERE FM.USE_YN = 'Y'              -- 사용중인 농장
  AND FM.TEST_YN = 'N'             -- 테스트 농장 제외
  AND EXISTS (
      SELECT 1 FROM TA_MEMBER UR
      WHERE UR.FARM_NO = FM.FARM_NO
        AND UR.USER_OK_CD = '991002'  -- 승인된 회원 존재
  )
ORDER BY SORT_ORDER, FM.FARM_NO    -- InsightPig 서비스 농장 우선
```

| 조건 | 설명 |
|------|------|
| `USE_YN = 'Y'` | 사용중인 농장만 |
| `TEST_YN = 'N'` | 테스트 농장 제외 |
| `USER_OK_CD = '991002'` | 승인된 회원이 1명 이상 존재 |
| `SORT_ORDER` | 0=InsightPig 서비스 농장 (우선), 1=일반 농장 |

#### 1.2.2 productivity (서비스 농장)

`productivity` 명령은 **InsightPig 서비스 농장**만 대상으로 합니다.

**조회 함수**: `get_service_farm_nos()` ([farm_service.py](../../inspig-etl/src/common/farm_service.py))

```sql
-- SERVICE_FARM_NO_SQL: 서비스 농장번호 조회
SELECT DISTINCT F.FARM_NO
FROM TA_FARM F
INNER JOIN VW_INS_SERVICE_ACTIVE S ON F.FARM_NO = S.FARM_NO
WHERE F.USE_YN = 'Y'
  AND NVL(S.REG_TYPE, 'AUTO') = 'AUTO'  -- 정기 배치 대상만
ORDER BY F.FARM_NO
```

| 조건 | 설명 |
|------|------|
| `VW_INS_SERVICE_ACTIVE` | 현재 유효한 InsightPig 서비스 구독 |
| `REG_TYPE = 'AUTO'` | 정기 배치 대상 (MANUAL 제외) |
| `--exclude-farms` | 제외 농장 지정 가능 (예: `"848,1234"`) |

### 1.3 실행 흐름 (ProductivityCollector)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                      ProductivityCollector 실행 흐름                              │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  [1] 초기화                                                                      │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │  collector = ProductivityCollector()                                     │    │
│  │  - base_url: http://10.4.35.10:11000                                    │    │
│  │  - timeout: 60초                                                         │    │
│  │  - max_workers: 4 (병렬 처리 스레드 수)                                   │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                              │                                                  │
│                              ▼                                                  │
│  [2] 수집 (collect)                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │  data = collector.collect(period='W', stat_date='20250120')              │    │
│  │                                                                         │    │
│  │  1. 대상 농장 조회                                                        │    │
│  │     └→ get_service_farm_nos(exclude_farms) → [농장 목록]                 │    │
│  │                                                                         │    │
│  │  2. 기간 정보 계산                                                        │    │
│  │     └→ _calculate_period_info(stat_date, period)                        │    │
│  │         → stat_year=2025, period_no=4 (4주차)                            │    │
│  │                                                                         │    │
│  │  3. API 병렬 호출 (ThreadPoolExecutor, max_workers=4)                    │    │
│  │     ├→ 농장 A: _fetch_productivity(farm_no, stat_date, period)          │    │
│  │     ├→ 농장 B: _fetch_productivity(...)                                 │    │
│  │     ├→ 농장 C: _fetch_productivity(...)                                 │    │
│  │     └→ 농장 D: _fetch_productivity(...)                                 │    │
│  │                                                                         │    │
│  │  4. 응답 변환                                                             │    │
│  │     └→ _process_response() → PCODE별 Row 생성                            │    │
│  │         ├→ 031 (교배): C001~C039 매핑                                    │    │
│  │         ├→ 032 (분만): C001~C024 매핑                                    │    │
│  │         ├→ 033 (이유): C001~C018 매핑                                    │    │
│  │         ├→ 034 (번식종합): C001~C030 매핑                                 │    │
│  │         └→ 035 (모돈현황): C001~C013 매핑                                 │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                              │                                                  │
│                              ▼                                                  │
│  [3] 저장 (save)                                                                │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │  collector.save(data)                                                    │    │
│  │                                                                         │    │
│  │  1. DELETE (UK 기준)                                                     │    │
│  │     DELETE FROM TS_PRODUCTIVITY                                         │    │
│  │     WHERE FARM_NO = :FARM_NO AND PCODE = :PCODE                         │    │
│  │       AND STAT_YEAR = :STAT_YEAR AND PERIOD = :PERIOD                   │    │
│  │       AND PERIOD_NO = :PERIOD_NO                                        │    │
│  │                                                                         │    │
│  │  2. INSERT                                                               │    │
│  │     INSERT INTO TS_PRODUCTIVITY                                         │    │
│  │     (SEQ, FARM_NO, PCODE, STAT_YEAR, PERIOD, PERIOD_NO,                 │    │
│  │      STAT_DATE, C001, C002, ..., INS_DT)                                │    │
│  │     VALUES (SEQ_TS_PRODUCTIVITY.NEXTVAL, ...)                           │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                              │                                                  │
│                              ▼                                                  │
│  [4] 연동 (선택)                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │  collector.update_ins_week_sangsi(stat_year, period, period_no)          │    │
│  │                                                                         │    │
│  │  TS_PRODUCTIVITY.C001 (PCODE='035') → TS_INS_WEEK.MODON_SANGSI_CNT      │    │
│  │  (상시모돈수 업데이트)                                                     │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 1.4 CLI 실행 예시

> 전체 CLI 명령어는 [07_RUN_ETL_CLI.md](./07_RUN_ETL_CLI.md) 참조

#### 주요 명령어

```bash
# 전체 농장 주간 생산성
python run_etl.py productivity-all --period W

# 전체 농장 월간 생산성
python run_etl.py productivity-all --period M

# 서비스 농장만 주간 생산성
python run_etl.py productivity

# Dry-run (확인만)
python run_etl.py productivity-all --dry-run
```

#### Shell 스크립트 (Cron용)

```bash
./run_productivity_all.sh W   # 주간
./run_productivity_all.sh M   # 월간
./run_productivity_all.sh Q   # 분기
```

### 1.5 Python 사용 예시

#### 서비스 농장 수집 (productivity)

```python
from src.collectors.productivity import ProductivityCollector

# 주간 데이터 수집 (2025년 4주차)
collector = ProductivityCollector()
data = collector.collect(period='W', stat_date='20250120')
collector.save(data)

# 월간 데이터 수집 (2025년 1월)
data = collector.collect(period='M', stat_date='20250120')
collector.save(data)

# 상시모돈수 → TS_INS_WEEK 연동
collector.update_ins_week_sangsi(
    stat_year=2025,
    period='W',
    period_no=4
)
```

#### 전체 농장 수집 (productivity-all)

```python
from src.collectors.productivity import ProductivityCollector

# 전체 농장 주간 데이터 수집
collector = ProductivityCollector()
data = collector.collect_all(period='W', stat_date='20250120')
collector.save(data)

# 전체 농장 월간 데이터 수집
data = collector.collect_all(period='M', stat_date='20250120')
collector.save(data)

# 데이터 존재 여부 확인 후 수집 (중복 방지)
if not collector.exists(farm_no=1387, period='W', stat_date='20250120'):
    data = collector.collect_if_not_exists(
        farm_no=1387,
        period='W',
        stat_date='20250120'
    )
    collector.save(data)
```

---

## 2. 키 컬럼 생성규칙

### 2.1 FARM_NO (농장번호)

| 항목 | 설명 |
|------|------|
| 타입 | NUMBER(10) |
| 설명 | 농장 고유번호 |
| FK 참조 | TA_FARM.FARM_NO |
| 생성규칙 | 서비스 신청 농장 목록에서 조회 |

### 2.2 PCODE (생산성 코드)

| 항목 | 설명 |
|------|------|
| 타입 | VARCHAR2(3) |
| 설명 | 생산성 데이터 종류 구분 |
| 생성규칙 | API 응답의 `__STATCD__` 앞 3자리 |

**PCODE 값:**

| PCODE | 설명 | 항목 수 | 주요 지표 |
|-------|------|---------|----------|
| 031 | 교배 | 28개 | 교배복수, 재발교배비율, 7일내재귀율 |
| 032 | 분만 | 24개 | 분만복수, 총산자수, 실산자수 |
| 033 | 이유 | 18개 | 이유복수, 이유두수, 평균체중 |
| 034 | 번식종합 | 30개 | PSY, MSY, 분만율 |
| 035 | 모돈현황 | 13개 | 상시모돈수, 등록모돈수 |

### 2.3 STAT_YEAR (통계년도)

| 항목 | 설명 |
|------|------|
| 타입 | NUMBER(4) |
| 설명 | 통계 기준 년도 |
| 생성규칙 | `stat_date`의 년도 부분 (YYYY) |
| 예시 | 2025 |

### 2.4 PERIOD (기간구분)

| 항목 | 설명 |
|------|------|
| 타입 | VARCHAR2(1) |
| 설명 | 통계 기간 단위 구분 |
| 생성규칙 | ETL 실행 시 파라미터로 지정 |

**PERIOD 값:**

| 값 | 설명 | PERIOD_NO 범위 | 사용처 |
|----|------|----------------|--------|
| W | 주간 | 1~53 (ISO 주차) | 주간 리포트 |
| M | 월간 | 1~12 (월) | 월간 리포트 |
| Q | 분기 | 1~4 (분기) | 분기 리포트 |

### 2.5 PERIOD_NO (기간차수)

| 항목 | 설명 |
|------|------|
| 타입 | NUMBER(2) |
| 설명 | 해당 기간의 차수 (주차/월/분기) |
| 생성규칙 | `stat_date` 기준 계산 |

**계산 로직 (Python):**

```python
from datetime import datetime

def calculate_period_no(stat_date: str, period: str) -> int:
    """기준일로부터 기간차수 계산"""
    dt = datetime.strptime(stat_date, '%Y%m%d')

    if period == 'W':
        # ISO 8601 주차 (1~53)
        return dt.isocalendar()[1]
    elif period == 'M':
        # 월 (1~12)
        return dt.month
    elif period == 'Q':
        # 분기 (1~4): 1~3월=1, 4~6월=2, 7~9월=3, 10~12월=4
        return (dt.month - 1) // 3 + 1
```

**예시:**

| stat_date | PERIOD | PERIOD_NO | 설명 |
|-----------|--------|-----------|------|
| 20250113 | W | 3 | 2025년 3주차 |
| 20250113 | M | 1 | 2025년 1월 |
| 20250113 | Q | 1 | 2025년 1분기 |
| 20251225 | W | 52 | 2025년 52주차 |
| 20251225 | M | 12 | 2025년 12월 |
| 20251225 | Q | 4 | 2025년 4분기 |

### 2.6 STAT_DATE (통계기준일)

| 항목 | 설명 |
|------|------|
| 타입 | VARCHAR2(10) |
| 설명 | API 호출 시 사용한 기준일 |
| 형식 | YYYY-MM-DD |
| 생성규칙 | ETL 실행 시 `--base-date` 또는 현재일 |

---

## 3. 데이터 컬럼 (C001~C043)

### 3.1 컬럼명 생성규칙

| 항목 | 규칙 |
|------|------|
| API 응답 | `__STATCD__` = "031001" |
| 컬럼명 변환 | "C" + 뒤 3자리 = "C001" |
| 예시 | 031001 → C001, 035024 → C024 |

**변환 로직:**

```python
stat_cd = item.get('__STATCD__')  # "031001"
pcode = stat_cd[:3]               # "031"
col_suffix = stat_cd[3:]          # "001"
col_name = f"C{col_suffix}"       # "C001"
```

### 3.2 TC_CODE_SYS 참조

웹 시스템에서 컬럼명과 통계명을 매핑할 때 사용:

```sql
-- 컬럼 정보 조회
SELECT CODE, CNAME AS STAT_NM, HELP_MSG
FROM TC_CODE_SYS
WHERE PCODE IN ('031','032','033','034','035')
  AND CODE = '031001';  -- PCODE + 컬럼뒤3자리

-- HELP_MSG 형식 (JSON)
-- {"tooltip":"설명 텍스트"}
```

### 3.3 PCODE별 전체 컬럼

#### 031 (교배) - 28개 항목

| 컬럼 | 코드 | 통계명 |
|------|------|--------|
| C001 | 031001 | 교배복수 |
| C002 | 031002 | 교배두수 |
| C003 | 031003 | 복당교배두수 |
| C004 | 031004 | 평균교배횟수 |
| C005 | 031005 | 1회교배비율 |
| C006 | 031006 | 2회교배비율 |
| C007 | 031007 | 3회이상교배비율 |
| C008 | 031008 | 자연교배비율 |
| C009 | 031009 | 인공수정비율 |
| C010 | 031010 | 혼합교배비율 |
| C011 | 031011 | 경산돈교배복수 |
| C012 | 031012 | 경산돈교배비율 |
| C013 | 031013 | 정상교배 |
| C014 | 031014 | 1차재발교배 |
| C015 | 031015 | 2차재발교배 |
| C016 | 031016 | 기타사고후교배 |
| C017 | 031017 | 미경산돈교배복수 |
| C018 | 031018 | 미경산돈교배비율 |
| C019 | 031019 | 후보돈교배복수 |
| C020 | 031020 | 후보돈교배비율 |
| C021 | 031021 | 대체돈교배복수 |
| C022 | 031022 | 대체돈교배비율 |
| C023 | 031023 | 웅돈당교배복수 |
| C024 | 031024 | 초교배복수(모돈편입) |
| C025 | 031025 | 평균초교배일령 |
| C028 | 031028 | 평균재귀발정일령 |
| C037 | 031037 | 7일내재귀율 |
| C039 | 031039 | 재발교배비율 |

#### 032 (분만) - 24개 항목

| 컬럼 | 코드 | 통계명 |
|------|------|--------|
| C001 | 032001 | 분만예정복수 |
| C002 | 032002 | 분만예정두수 |
| C003 | 032003 | 복당분만예정두수 |
| C004 | 032004 | 1산차분만예정복수 |
| C005 | 032005 | 1산차분만예정비율 |
| C006 | 032006 | 경산분만예정복수 |
| C007 | 032007 | 경산분만예정비율 |
| C008 | 032008 | 고산차분만예정복수 |
| C009 | 032009 | 고산차분만예정비율 |
| C010 | 032010 | 분만복수 |
| C011 | 032011 | 총산자수 |
| C012 | 032012 | 실산자수 |
| C013 | 032013 | 사산 |
| C014 | 032014 | 미라 |
| C015 | 032015 | 기형 |
| C016 | 032016 | 복당총산자수 |
| C017 | 032017 | 복당실산자수 |
| C018 | 032018 | 복당사산수 |
| C019 | 032019 | 복당미라수 |
| C020 | 032020 | 사산비율 |
| C021 | 032021 | 미라비율 |
| C022 | 032022 | 평균임신기간 |
| C023 | 032023 | 평균분만산차 |
| C024 | 032024 | 평균생시체중 |

#### 033 (이유) - 18개 항목

| 컬럼 | 코드 | 통계명 |
|------|------|--------|
| C001 | 033001 | 이유복수 |
| C002 | 033002 | 이유두수 |
| C003 | 033003 | 복당이유두수 |
| C004 | 033004 | 평균이유일령 |
| C005 | 033005 | 평균이유체중 |
| C006 | 033006 | 포유중폐사두수 |
| C007 | 033007 | 포유중폐사율 |
| C008 | 033008 | 이유전도태두수 |
| C009 | 033009 | 이유전도태율 |
| C010 | 033010 | 포유개시두수 |
| C011 | 033011 | 복당포유개시두수 |
| C012 | 033012 | 양자입양두수 |
| C013 | 033013 | 양자출양두수 |
| C014 | 033014 | 양자증감두수 |
| C015 | 033015 | 대리모복수 |
| C016 | 033016 | 대리모이유두수 |
| C017 | 033017 | 복당대리모이유두수 |
| C018 | 033018 | 평균이유산차 |

#### 034 (번식종합) - 30개 항목

| 컬럼 | 코드 | 통계명 | 비고 |
|------|------|--------|------|
| C001 | 034001 | 분만율 | ★★ |
| C002 | 034002 | 평균산차 | ★ |
| C003 | 034003 | 평균임신기간 | |
| C004 | 034004 | 평균포유기간 | |
| C005 | 034005 | 평균비생산일수(NPD) | |
| C006 | 034006 | 평균이유후교배일 | |
| C007 | 034007 | 포유중사고율 | |
| C008 | 034008 | 연간모돈회전율 | |
| C009 | 034009 | 복당총산자수 | |
| C010 | 034010 | 복당실산자수 | |
| C011 | 034011 | 복당사산수 | |
| C012 | 034012 | 복당미라수 | |
| C013 | 034013 | 복당이유두수 | |
| C014 | 034014 | 재발율 | |
| C015 | 034015 | 유산율 | |
| C016 | 034016 | 분만전폐사율 | |
| C017 | 034017 | 사고율 | |
| C018 | 034018 | 도태율 | |
| C019 | 034019 | 폐사율 | |
| C020 | 034020 | 분만간격 | |
| C021 | 034021 | 연산자수 | |
| C022 | 034022 | 연이유두수 | |
| C023 | 034023 | PSY | ★★★ |
| C024 | 034024 | 연간분만복수 | |
| C025 | 034025 | 1회교배수태율 | |
| C026 | 034026 | 이유후7일내교배율 | |
| C027 | 034027 | 이유후평균교배일 | |
| C028 | 034028 | 교배후분만율 | |
| C029 | 034029 | MSY | ★★★ |
| C030 | 034030 | 모돈갱신율 | |

#### 035 (모돈현황) - 13개 항목

| 컬럼 | 코드 | 통계명 | 용도 |
|------|------|--------|------|
| C001 | 035001 | 상시모돈수 | TS_INS_WEEK.MODON_SANGSI_CNT |
| C002 | 035002 | 등록모돈수 | 현재모돈수 |
| C003 | 035003 | 후보돈수 | - |
| C004 | 035004 | 미경산돈수 | - |
| C005 | 035005 | 임신돈수 | - |
| C006 | 035006 | 포유돈수 | - |
| C007 | 035007 | 공태돈수 | - |
| C008 | 035008 | 웅돈수 | - |
| C009 | 035009 | 평균산차 | - |
| C010 | 035010 | 고산차모돈수 | - |
| C011 | 035011 | 고산차비율 | - |
| C012 | 035012 | 전입모돈수 | - |
| C013 | 035013 | 전출모돈수 | - |

---

## 4. ETL 로직

### 4.1 데이터 수집 흐름

```
┌──────────────────────────────────────────────────────────────────────────┐
│                     ProductivityCollector.collect()                       │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  1. 대상 농장 조회 (TS_INS_SERVICE 유효 서비스 농장)                       │
│     └→ get_service_farm_nos(exclude_farms)                               │
│                                                                          │
│  2. 기간 정보 계산                                                        │
│     └→ _calculate_period_info(stat_date, period)                         │
│         → stat_year, period_no 산출                                      │
│                                                                          │
│  3. API 병렬 호출 (ThreadPoolExecutor)                                   │
│     └→ 농장별 _fetch_productivity() 호출                                  │
│         └→ GET /statistics/productivity/period/{farmNo}                  │
│                                                                          │
│  4. 응답 변환                                                             │
│     └→ _process_response()                                               │
│         └→ PCODE별 Row 생성 (C001~C043 컬럼 매핑)                         │
│                                                                          │
│  5. 저장                                                                  │
│     └→ save()                                                            │
│         └→ DELETE (UK 기준) + INSERT                                     │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### 4.2 API 호출 형식

```
GET http://10.4.35.10:11000/statistics/productivity/period/{farmNo}
```

| 파라미터 | 값 | 고정/가변 |
|----------|-----|----------|
| statDate | YYYY-MM-DD | 가변 |
| memberId | null | 가변 (기본 null) |
| period | W/M | 가변 (Q는 M으로 호출) |
| lang | ko | 고정 |
| serviceId | 01051 | 고정 |
| sizeOfPeriod | 1 | 고정 |
| numOfPeriod | 1 | 고정 |
| pumjongCd | - 전체 - | 고정 |
| reportType | 1 | 고정 |

### 4.3 API 응답 구조

```json
{
    "data": [
        {
            "__INDEX__": "2025-01-13",
            "__STATCD__": "035001",
            "__PCODE__": "035",
            "__PCNAME__": "생산회전율",
            "__STATNM__": "상시모돈수",
            "__VAL__": "554.55",
            "__TOOLTIP__": "설명"
        }
    ]
}
```

### 4.4 저장 로직

```sql
-- 1. 기존 데이터 삭제 (UK 기준)
DELETE FROM TS_PRODUCTIVITY
WHERE FARM_NO = :FARM_NO
  AND PCODE = :PCODE
  AND STAT_YEAR = :STAT_YEAR
  AND PERIOD = :PERIOD
  AND PERIOD_NO = :PERIOD_NO;

-- 2. 새 데이터 INSERT
INSERT INTO TS_PRODUCTIVITY (
    SEQ, FARM_NO, PCODE, STAT_YEAR, PERIOD, PERIOD_NO, STAT_DATE,
    C001, C002, ..., INS_DT
) VALUES (
    SEQ_TS_PRODUCTIVITY.NEXTVAL, :FARM_NO, :PCODE, :STAT_YEAR, :PERIOD, :PERIOD_NO, :STAT_DATE,
    :C001, :C002, ..., SYSDATE
);
```

---

## 5. 조회 예시

### 5.1 특정 주차 데이터 조회

```sql
-- 2025년 3주차 주간 데이터 (번식종합)
SELECT FARM_NO,
       C023 AS PSY,
       C029 AS MSY,
       C001 AS "분만율"
FROM TS_PRODUCTIVITY
WHERE STAT_YEAR = 2025
  AND PERIOD = 'W'
  AND PERIOD_NO = 3
  AND PCODE = '034';
```

### 5.2 상시모돈수 조회

```sql
-- 상시모돈수 (035 모돈현황의 C001)
SELECT FARM_NO, C001 AS SANGSI_MODON_CNT
FROM TS_PRODUCTIVITY
WHERE PCODE = '035'
  AND STAT_YEAR = 2025
  AND PERIOD = 'W'
  AND PERIOD_NO = 3;
```

### 5.3 TS_INS_WEEK 연동

```sql
-- TS_PRODUCTIVITY → TS_INS_WEEK.MODON_SANGSI_CNT 업데이트
UPDATE TS_INS_WEEK W
SET W.MODON_SANGSI_CNT = (
    SELECT NVL(P.C001, 0)
    FROM TS_PRODUCTIVITY P
    WHERE P.FARM_NO = W.FARM_NO
      AND P.PCODE = '035'
      AND P.STAT_YEAR = W.REPORT_YEAR
      AND P.PERIOD = 'W'
      AND P.PERIOD_NO = W.REPORT_WEEK_NO
)
WHERE W.REPORT_YEAR = :year
  AND W.REPORT_WEEK_NO = :week_no;
```

---

## 6. CLI 실행 예시

```bash
# 생산성 데이터만 수집 (주간)
python run_etl.py productivity

# 특정 날짜 기준 수집
python run_etl.py productivity --base-date 2025-01-13

# 테스트 모드 (특정 농장만)
python run_etl.py productivity --test --farm-list "1387,2807"

# 전체 ETL (생산성 + 주간리포트)
python run_etl.py all
```

---

## 관련 문서

- [01_ETL_OVERVIEW.md](./01_ETL_OVERVIEW.md) - ETL 시스템 개요
- [05_OPERATION_GUIDE.md](./05_OPERATION_GUIDE.md) - ETL 운영 가이드
- [07_RUN_ETL_CLI.md](./07_RUN_ETL_CLI.md) - CLI 명령어 레퍼런스
- [02.table.md](../db/ins/02.table.md) - INS 테이블 전체 구조

## 관련 소스

- [productivity.py](../../inspig-etl/src/collectors/productivity.py) - ETL 수집기
- [TS_PRODUCTIVITY.sql](../db/sql/ins/ddl/TS_PRODUCTIVITY.sql) - DDL

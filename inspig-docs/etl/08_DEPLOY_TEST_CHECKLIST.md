# 운영 서버 배포 테스트 체크리스트

> 운영 환경에서 ETL 테스트 시 `--dry-run` 모드 사용 (데이터 등록 안함)

---

## 1. 서버 접속

```bash
# SSH 접속
ssh -i "E:/ssh key/sshkey/aws/ProdPigplanKey.pem" pigplan@10.4.35.10

# ETL 디렉토리 이동
cd /data/etl/inspig

# Conda 환경 활성화
source /data/anaconda/anaconda3/etc/profile.d/conda.sh
conda activate inspig-etl
```

---

## 2. ETL 테스트 (dry-run)

### 2.1 생산성 ETL (productivity-all)

```bash
# 전체 농장 주간 생산성 - 대상 농장 수 확인
python run_etl.py productivity-all --period W --dry-run

# 전체 농장 월간 생산성
python run_etl.py productivity-all --period M --dry-run

# 서비스 농장만 생산성
python run_etl.py productivity --dry-run
```

**확인 사항:**
- [ ] 대상 농장 수 출력
- [ ] InsightPig 서비스 농장 수 출력
- [ ] 일반 농장 수 출력
- [ ] 기간구분 (W/M) 출력

### 2.2 주간 리포트 ETL (weekly)

```bash
# 전체 서비스 농장
python run_etl.py weekly --dry-run

# AM7 그룹 (오전 7시 알림)
python run_etl.py weekly --schedule-group AM7 --dry-run

# PM2 그룹 (오후 2시 알림)
python run_etl.py weekly --schedule-group PM2 --dry-run
```

**확인 사항:**
- [ ] 대상 농장 목록 출력
- [ ] 스케줄 그룹 필터링 정상 동작
- [ ] DB 연결 정상

### 2.3 기상청 ETL (weather)

```bash
# 기상청 데이터 수집
python run_etl.py weather --dry-run
```

**확인 사항:**
- [ ] API 키 설정 확인
- [ ] 대상 지역 코드 확인

---

## 3. Crontab 테스트

### 3.1 현재 크론탭 확인

```bash
crontab -l
```

### 3.2 예상 크론탭 내용

```bash
# 생산성 주간 (월 00:05 KST)
5 15 * * 0 /data/etl/inspig/run_productivity_all.sh W

# 생산성 월간 (1일 00:05 KST)
5 15 28-31 * * [ "$(date -d tomorrow +\%d)" = "01" ] && /data/etl/inspig/run_productivity_all.sh M

# 주간 ETL AM7 (월 02:00 KST)
0 17 * * 0 /data/etl/inspig/run_weekly.sh AM7

# 주간 ETL PM2 (월 12:00 KST)
0 3 * * 1 /data/etl/inspig/run_weekly.sh PM2
```

### 3.3 쉘 스크립트 실행 권한 확인

```bash
ls -la run_*.sh
# -rwxr-xr-x 권한 확인
```

### 3.4 쉘 스크립트 줄바꿈 확인 (CRLF → LF)

```bash
# CRLF 확인 (출력 있으면 문제)
cat -A run_productivity_all.sh | grep '\^M'
cat -A run_weekly.sh | grep '\^M'

# 문제 있으면 변환
sed -i 's/\r$//' run_productivity_all.sh
sed -i 's/\r$//' run_weekly.sh
```

---

## 4. 수동 생성 테스트 (pig3.1)

### 4.1 API 서버 상태 확인

```bash
# 헬스체크
curl http://localhost:8001/health

# API 서버 상태
sudo systemctl status inspig-etl-api
```

### 4.2 수동 생성 API 테스트

pig3.1 시스템에서 수동 생성 시 호출되는 API:

```bash
# 생산성 데이터 존재 여부 확인 (예: 농장 1387, 2025년 5주차)
curl "http://10.4.35.10:8001/productivity/exists?farm_no=1387&stat_year=2025&period=W&period_no=5"

# 수동 생성 (dry-run은 API에서 미지원, 실제 등록됨 - 주의!)
# curl -X POST "http://10.4.35.10:8001/batch/manual" \
#   -H "Content-Type: application/json" \
#   -d '{"farm_no": 1387}'
```

### 4.3 CLI 수동 실행 테스트 (dry-run)

```bash
# 특정 농장 수동 실행 (dry-run)
python run_etl.py --manual --farm-no 1387 --dry-run

# 특정 기간 지정 (dry-run)
python run_etl.py --manual --farm-no 1387 --dt-from 20250120 --dt-to 20250126 --dry-run
```

---

## 5. 로그 확인

```bash
# 최근 로그 파일
ls -lt logs/ | head -10

# 로그 내용 확인
tail -100 logs/cron_AM7_*.log
tail -100 logs/productivity_all_W_*.log
```

---

## 6. 테스트 결과 체크리스트

| 항목 | 상태 | 비고 |
|------|------|------|
| **생산성 ETL** | | |
| └ productivity-all W dry-run | ☐ | 대상 농장 수 확인 |
| └ productivity-all M dry-run | ☐ | 월간 대상 확인 |
| └ productivity dry-run | ☐ | 서비스 농장만 |
| **주간 리포트 ETL** | | |
| └ weekly dry-run | ☐ | 전체 대상 |
| └ weekly AM7 dry-run | ☐ | AM7 그룹 |
| └ weekly PM2 dry-run | ☐ | PM2 그룹 |
| **기상청 ETL** | | |
| └ weather dry-run | ☐ | API 키 확인 |
| **Crontab** | | |
| └ 크론탭 등록 확인 | ☐ | crontab -l |
| └ 쉘 스크립트 권한 | ☐ | chmod +x |
| └ 줄바꿈 형식 (LF) | ☐ | CRLF 변환 |
| **수동 생성** | | |
| └ API 서버 헬스체크 | ☐ | /health |
| └ exists API 테스트 | ☐ | 존재 여부 확인 |
| └ CLI 수동 dry-run | ☐ | --manual --dry-run |

---

## 7. 주의 사항

- `--dry-run` 옵션 없이 실행하면 **실제 데이터 등록됨**
- 수동 생성 API (`/batch/manual`)는 dry-run 미지원
- 크론 실행 시간: UTC 기준 (KST = UTC + 9시간)
- 로그 파일: 30일 후 자동 삭제

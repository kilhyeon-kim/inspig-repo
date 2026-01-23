import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TsInsWeekSub } from './entities';
import { WEEKLY_SQL } from './sql';
import { COM_SQL } from '../com/sql/com.sql';
import { SHARE_TOKEN_SQL } from '../auth/sql/share-token.sql';
import { ComService } from '../com/com.service';
import { nowKst, parseExpireDateKst } from '../../common/utils';
import * as mockData from '../../data/mock/weekly.mock';

/**
 * Named parameter를 TypeORM query에 전달하기 위한 헬퍼
 * TypeORM Oracle 드라이버는 named parameter 객체를 지원하지만
 * TypeScript 타입 정의가 any[]로 되어 있어 캐스팅 필요
 */
const params = (obj: Record<string, any>): any => obj;

/**
 * 주간 리포트 서비스
 * - 실제 DB 연동 (Oracle)
 * - DB 연결 실패 시 Mock 데이터 fallback
 */
@Injectable()
export class WeeklyService {
  private readonly logger = new Logger(WeeklyService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly comService: ComService,
  ) { }

  // ─────────────────────────────────────────────────────────────────────────────
  // 보고서 목록/상세 (실제 DB 연동)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * 주간 보고서 목록 조회
   * @param farmNo 농장번호 (필수)
   * @param from 시작일 (YYYYMMDD)
   * @param to 종료일 (YYYYMMDD)
   */
  async getReportList(farmNo: number, from?: string, to?: string) {
    try {
      let results: any[];

      if (from && to) {
        results = await this.dataSource.query(
          WEEKLY_SQL.getReportListWithPeriod,
          params({ farmNo, dtFrom: from, dtTo: to }),
        );
      } else {
        results = await this.dataSource.query(WEEKLY_SQL.getReportList, params({ farmNo }));
      }

      return results.map((row: any) => ({
        id: `${row.SEQ}`,
        masterSeq: row.SEQ,
        year: row.REPORT_YEAR,
        weekNo: row.REPORT_WEEK_NO,
        period: {
          from: row.DT_FROM,
          to: row.DT_TO,
          fromRaw: row.DT_FROM_RAW,  // YYYYMMDD 형식
          toRaw: row.DT_TO_RAW,      // YYYYMMDD 형식
        },
        statusCd: row.STATUS_CD,
        createdAt: row.LOG_INS_DT,
        shareToken: row.SHARE_TOKEN || null,
        farmNm: row.FARM_NM,
      }));
    } catch (error) {
      this.logger.error('리포트 목록 조회 실패', error.message);
      // Mock 데이터 대신 빈 배열 반환 (에러 상황을 명확히 표시)
      return [];
    }
  }

  /**
   * 공유 토큰 검증 (만료일 체크 포함)
   * 역할: 토큰 검증 및 PK 추출만 수행
   * @param shareToken 공유 토큰 (64자 SHA256 해시)
   * @param skipExpiryCheck 만료일 검증 건너뛰기 여부 (로그인 사용자용)
   */
  async validateShareToken(shareToken: string, skipExpiryCheck: boolean = false): Promise<{
    valid: boolean;
    expired: boolean;
    masterSeq: number | null;
    farmNo: number | null;
    message?: string;
  }> {
    try {
      // SHARE_TOKEN_SQL 사용 (토큰 검증 및 PK 추출만)
      const results = await this.dataSource.query(SHARE_TOKEN_SQL.validateToken, params({ shareToken }));
      const tokenData = results[0];

      if (!tokenData) {
        return {
          valid: false,
          expired: false,
          masterSeq: null,
          farmNo: null,
          message: '해당 공유 토큰에 대한 리포트를 찾을 수 없습니다. 리포트가 삭제되었거나 토큰이 잘못되었을 수 있습니다.'
        };
      }

      // 만료일 체크 (skipExpiryCheck가 true면 건너뜀, 한국 시간 기준)
      if (!skipExpiryCheck && tokenData.TOKEN_EXPIRE_DT) {
        const now = nowKst();
        // TOKEN_EXPIRE_DT는 YYYYMMDD 형식 (KST 기준)
        const expireDate = parseExpireDateKst(tokenData.TOKEN_EXPIRE_DT);

        if (now > expireDate) {
          return {
            valid: false,
            expired: true,
            masterSeq: tokenData.MASTER_SEQ,
            farmNo: tokenData.FARM_NO,
            message: '공유 링크가 만료되었습니다. 이 링크는 유효기간(7일)이 지났습니다.'
          };
        }
      }

      return {
        valid: true,
        expired: false,
        masterSeq: tokenData.MASTER_SEQ,
        farmNo: tokenData.FARM_NO
      };
    } catch (error) {
      this.logger.error('토큰 검증 실패', error.message);
      return {
        valid: false,
        expired: false,
        masterSeq: null,
        farmNo: null,
        message: '토큰 검증 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.'
      };
    }
  }

  /**
   * 공유 토큰으로 주간 보고서 조회 (만료일 검증 없음 - 로그인 사용자용)
   * 역할: 토큰 검증 후 getReportDetail 재사용
   * @param shareToken 공유 토큰 (64자 SHA256 해시)
   */
  async getReportByShareToken(shareToken: string) {
    try {
      // 1. 토큰 검증 및 PK 추출 (SHARE_TOKEN_SQL 사용)
      const results = await this.dataSource.query(SHARE_TOKEN_SQL.validateToken, params({ shareToken }));
      const tokenData = results[0];

      if (!tokenData) {
        this.logger.warn(`Report not found for token: ${shareToken.substring(0, 8)}...`);
        return null;
      }

      // 2. PK로 리포트 상세 조회 (getReportDetail 재사용)
      return this.getReportDetail(tokenData.MASTER_SEQ, tokenData.FARM_NO);
    } catch (error) {
      this.logger.error('공유 토큰 조회 실패', error.message);
      return null;
    }
  }

  /**
   * 공유 토큰으로 주간 보고서 조회 (만료일 검증 포함 - 외부 공유 링크용)
   * 역할: 토큰 검증 후 getReportDetail 재사용
   * @param skipExpiryCheck 만료일 검증 건너뛰기 여부 (로그인 사용자용)
   */
  async getReportByShareTokenWithExpiry(shareToken: string, skipExpiryCheck: boolean = false): Promise<{
    success: boolean;
    expired: boolean;
    data: any;
    message?: string;
  }> {
    // 1. 토큰 검증 (만료일 체크 포함)
    const validation = await this.validateShareToken(shareToken, skipExpiryCheck);

    if (!validation.valid || !validation.masterSeq || !validation.farmNo) {
      return {
        success: false,
        expired: validation.expired,
        data: null,
        message: validation.message,
      };
    }

    // 2. PK로 리포트 상세 조회 (getReportDetail 재사용)
    const reportData = await this.getReportDetail(validation.masterSeq, validation.farmNo);

    if (!reportData) {
      return {
        success: false,
        expired: false,
        data: null,
        message: '리포트 데이터를 불러올 수 없습니다.',
      };
    }

    return {
      success: true,
      expired: false,
      data: reportData,
    };
  }

  /**
   * 주간 보고서 상세 조회
   * @param masterSeq 마스터 SEQ
   * @param farmNo 농장번호
   */
  async getReportDetail(masterSeq: number, farmNo: number) {
    try {
      // 1. WEEK 조회
      const weekResults = await this.dataSource.query(
        WEEKLY_SQL.getReportDetail,
        params({ masterSeq, farmNo }),
      );
      const week = weekResults[0];

      if (!week) {
        this.logger.warn(`Week not found: masterSeq=${masterSeq}, farmNo=${farmNo}`);
        return null;
      }

      // 2. SUB 데이터 조회
      const subs = await this.dataSource.query(WEEKLY_SQL.getReportSub, params({ masterSeq, farmNo }));

      // 3. 관리포인트 조회 (TS_INS_MGMT)
      // 관리포인트 조회 (USE_YN='Y' 전체, 만료 판단은 프론트에서)
      let mgmtData = { quizList: [] as any[], channelList: [] as any[], porkNewsList: [] as any[], periodFrom: '', periodTo: '' };

      try {
        const dtFromStr = week.DT_FROM; // 예: "24.12.23"
        const dtToStr = week.DT_TO;     // 예: "24.12.29"

        if (dtFromStr && dtToStr) {
          // YY.MM.DD → Date 변환
          const parseDate = (str: string): Date => {
            const [yy, mm, dd] = str.split('.');
            const year = parseInt(yy) + 2000;
            return new Date(year, parseInt(mm) - 1, parseInt(dd));
          };

          const dtFromDate = parseDate(dtFromStr);
          const dtToDate = parseDate(dtToStr);

          // 지난주 시작일 = 금주 시작일 - 7일
          const prevDtFromDate = new Date(dtFromDate);
          prevDtFromDate.setDate(prevDtFromDate.getDate() - 7);

          // 다음주 종료일 = 금주 종료일 + 7일 (금주 작업예정 기간 포함)
          const nextDtToDate = new Date(dtToDate);
          nextDtToDate.setDate(nextDtToDate.getDate() + 7);

          // YYYYMMDD 포맷으로 변환
          const formatYYYYMMDD = (d: Date): string => {
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            return `${yyyy}${mm}${dd}`;
          };

          const mgmtPeriodFrom = formatYYYYMMDD(prevDtFromDate);
          const mgmtPeriodTo = formatYYYYMMDD(nextDtToDate);

          const mgmtRows = await this.dataSource.query(WEEKLY_SQL.getMgmtList);

          this.logger.debug(`getMgmtList rows: ${mgmtRows?.length || 0}`);

          const extracted = await this.extractMgmtData(mgmtRows);
          mgmtData = {
            ...extracted,
            periodFrom: mgmtPeriodFrom,  // 지난주 시작일 (YYYYMMDD)
            periodTo: mgmtPeriodTo,       // 다음주 종료일 (YYYYMMDD)
          };
        }
      } catch (e) {
        this.logger.error(`getMgmtList error: ${e.message}`);
      }

      // 4. 데이터 변환
      const reportData = this.transformToReportDetailFromRow(week, subs, mgmtData);

      // 4. 팝업 데이터 추가 (모든 팝업 데이터를 한 번에 조회)
      const popupData = await this.getAllPopupData(masterSeq, farmNo);

      // 5. 경락가격 실시간 조회 (extra.price + auction 팝업)
      // DT_FROM, DT_TO: YY.MM.DD 형식 그대로 전달 (SQL에서 YYYYMMDD로 변환)
      const dtFrom = week.DT_FROM;
      const dtTo = week.DT_TO;
      // DT_FROM_RAW, DT_TO_RAW: YYYYMMDD 형식 (날짜 비교용)
      const dtFromRaw = week.DT_FROM_RAW;
      const dtToRaw = week.DT_TO_RAW;
      let auctionPopupData: {
        xData: string[];
        grade1Plus: number[];
        grade1: number[];
        grade2: number[];
        gradeOut: number[];
        excludeOut: number[];
        average: number[];
      } | null = null;

      if (dtFrom && dtTo) {
        // 경락가격 통계 (cardPrice용)
        if (reportData.extra) {
          const auctionStats = await this.getAuctionPriceStats(dtFrom, dtTo);
          reportData.extra.price = {
            avg: auctionStats.avg,
            max: auctionStats.max,
            min: auctionStats.min,
            source: auctionStats.source,
          };
        }
        // 경락가격 등급별 (팝업 차트용)
        auctionPopupData = await this.getAuctionPopupData(dtFrom, dtTo);
      }

      // 6. 날씨 데이터 조회 (extra.weather용 + 팝업용)
      // 날씨는 금주 작업예정 기간(thisWeek.calendarGrid) 기준으로 조회
      const thisWeekFromRaw = reportData.thisWeek?.calendarGrid?.periodFromRaw;
      const thisWeekToRaw = reportData.thisWeek?.calendarGrid?.periodToRaw;

      // 과거 주차 여부 확인 (금주 작업예정 종료일이 오늘보다 이전)
      const today = nowKst();
      const todayStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
      const isPastWeek = thisWeekToRaw ? thisWeekToRaw < todayStr : false;

      // 7. 날씨 팝업 데이터 조회 (금주 작업예정 기간)
      let weatherPopupData: {
        xData: string[];
        maxTemp: number[];
        minTemp: number[];
        weatherCode: string[];
        rainProb: number[];
      } | null = null;

      // 금주 작업예정 기간의 날씨 데이터 조회 (extra.weather + 팝업 공용)
      // thisWeekFromRaw/thisWeekToRaw: YYYYMMDD 형식 (TM_WEATHER.WK_DATE와 일치)
      const weatherDaily = thisWeekFromRaw && thisWeekToRaw
        ? await this.getWeatherDaily(farmNo, thisWeekFromRaw, thisWeekToRaw)
        : null;

      if (isPastWeek) {
        // 과거 주차: 해당 주차의 날씨 데이터로 최고/최저 표시
        if (reportData.extra && weatherDaily && weatherDaily.daily.length > 0) {
          // 주간 최고/최저 계산
          const maxTemps = weatherDaily.daily.map(d => d.tempHigh).filter(t => t !== null) as number[];
          const minTemps = weatherDaily.daily.map(d => d.tempLow).filter(t => t !== null) as number[];
          reportData.extra.weather = {
            min: minTemps.length > 0 ? Math.min(...minTemps) : null,
            max: maxTemps.length > 0 ? Math.max(...maxTemps) : null,
            current: null, // 과거 주차는 현재 온도 없음
            region: weatherDaily.region || '',
            weatherCd: undefined,
            weatherNm: undefined,
          };
        }
      } else {
        // 금주: 오늘 날씨 표시
        const weatherToday = await this.getWeatherToday(farmNo);
        if (reportData.extra && weatherToday) {
          reportData.extra.weather = {
            min: weatherToday.min,
            max: weatherToday.max,
            current: weatherToday.current,
            region: weatherToday.region,
            weatherCd: weatherToday.weatherCd,
            weatherNm: weatherToday.weatherNm,
          };
        }
      }

      // 날씨 팝업 데이터 변환
      if (weatherDaily && weatherDaily.daily.length > 0) {
        const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
        weatherPopupData = {
          xData: weatherDaily.daily.map((d) => {
            const dt = new Date(
              parseInt(d.wkDate.substring(0, 4)),
              parseInt(d.wkDate.substring(4, 6)) - 1,
              parseInt(d.wkDate.substring(6, 8)),
            );
            return `${d.wkDate.substring(4, 6)}/${d.wkDate.substring(6, 8)}(${dayNames[dt.getDay()]})`;
          }),
          maxTemp: weatherDaily.daily.map((d) => d.tempHigh ?? 0),
          minTemp: weatherDaily.daily.map((d) => d.tempLow ?? 0),
          weatherCode: weatherDaily.daily.map((d) => d.weatherCd || 'sunny'),
          rainProb: weatherDaily.daily.map((d) => d.rainProb ?? 0),
        };
      }

      // 8. 상시모돈 데이터: TS_INS_WEEK.MODON_SANGSI_CNT 사용 (방식 2)
      // ETL에서 TS_PRODUCTIVITY → TS_INS_WEEK.MODON_SANGSI_CNT 업데이트
      // 웹에서는 TS_INS_WEEK에서 직접 읽어옴 (362라인의 sangsiCnt: week.MODON_SANGSI_CNT)

      return { ...reportData, popupData, auction: auctionPopupData, weather: weatherPopupData };
    } catch (error) {
      this.logger.error('DB 조회 실패', error.message);
      // DB 연동 완료 - Mock fallback 제거
      return null;
    }
  }

  /**
   * 모든 팝업 데이터 조회
   * @param masterSeq 마스터 SEQ
   * @param farmNo 농장번호
   */
  private async getAllPopupData(masterSeq: number, farmNo: number) {
    const popupTypes = ['modon', 'mating', 'farrowing', 'weaning', 'accident', 'culling', 'shipment'];
    const popupData: Record<string, any> = {};

    for (const type of popupTypes) {
      try {
        const data = await this.getPopupData(type, masterSeq, farmNo);
        if (data) {
          popupData[type] = data;
        }
      } catch (error) {
        this.logger.warn(`팝업 데이터 조회 실패: ${type}`, error.message);
      }
    }

    return popupData;
  }

  /**
   * 관리포인트 데이터 추출 (TS_INS_MGMT) - 리스트용 (CONTENT 제외)
   * 3개 유형: QUIZ(퀴즈), CHANNEL(박사채널&정보), PORK-NEWS(한돈&업계소식)
   * 모바일 메모리 부담 경감을 위해 CONTENT는 상세 조회 시에만 조회
   */
  private async extractMgmtData(mgmtRows: any[]): Promise<{
    quizList: { seq: number; mgmtType: string; title: string; link: string | null; linkTarget: string | null; videoUrl: string | null; postFrom: string | null; postTo: string | null }[];
    channelList: { seq: number; mgmtType: string; title: string; link: string | null; linkTarget: string | null; videoUrl: string | null; postFrom: string | null; postTo: string | null }[];
    porkNewsList: { seq: number; mgmtType: string; title: string; link: string | null; linkTarget: string | null; videoUrl: string | null; postFrom: string | null; postTo: string | null }[];
  }> {
    const quizList: any[] = [];
    const channelList: any[] = [];
    const porkNewsList: any[] = [];

    for (const row of mgmtRows) {
      // 리스트에서는 첨부파일 조회하지 않음 (상세에서만 조회)
      const item = {
        seq: row.SEQ || 0,
        mgmtType: row.MGMT_TYPE || 'QUIZ',
        title: row.TITLE || '',
        link: row.LINK_URL || null,
        linkTarget: row.LINK_TARGET || null,
        videoUrl: row.VIDEO_URL || null,
        postFrom: row.POST_FROM || null,
        postTo: row.POST_TO || null,
      };
      if (row.MGMT_TYPE === 'QUIZ') {
        quizList.push(item);
      } else if (row.MGMT_TYPE === 'CHANNEL') {
        channelList.push(item);
      } else if (row.MGMT_TYPE === 'PORK-NEWS') {
        porkNewsList.push(item);
      }
    }

    return { quizList, channelList, porkNewsList };
  }

  /**
   * 관리포인트 상세 조회 (단건) - CONTENT, 첨부파일 포함
   * @param seq - 관리포인트 SEQ
   */
  async getMgmtDetail(seq: number): Promise<{
    seq: number;
    mgmtType: string;
    title: string;
    content: string | null;
    contentType: string;
    link: string | null;
    linkTarget: string | null;
    videoUrl: string | null;
    postFrom: string | null;
    postTo: string | null;
    attachFiles?: any[];
  } | null> {
    try {
      const rows = await this.dataSource.query(
        WEEKLY_SQL.getMgmtDetail,
        params({ seq }),
      );

      if (!rows || rows.length === 0) {
        return null;
      }

      const row = rows[0];

      // 첨부파일 조회
      let attachFiles: any[] = [];
      try {
        const files = await this.dataSource.query(
          WEEKLY_SQL.getAttachFiles,
          params({ refTable: 'TS_INS_MGMT', refSeq: seq }),
        );
        attachFiles = files.map((f: any) => ({
          fileSeq: f.FILE_SEQ,
          fileNm: f.FILE_NM,
          fileOrgnlNm: f.FILE_ORGNL_NM,
          fileUrl: f.FILE_URL,
          fileSize: f.FILE_SIZE || 0,
          fileExt: f.FILE_EXT,
          mimeType: f.MIME_TYPE || null,
        }));
      } catch {
        // 첨부파일 테이블이 없을 수 있음 (무시)
      }

      return {
        seq: row.SEQ || 0,
        mgmtType: row.MGMT_TYPE || 'QUIZ',
        title: row.TITLE || '',
        content: row.CONTENT || null,
        contentType: row.CONTENT_TYPE || 'TEXT',
        link: row.LINK_URL || null,
        linkTarget: row.LINK_TARGET || null,
        videoUrl: row.VIDEO_URL || null,
        postFrom: row.POST_FROM || null,
        postTo: row.POST_TO || null,
        attachFiles: attachFiles.length > 0 ? attachFiles : undefined,
      };
    } catch (e) {
      this.logger.error(`getMgmtDetail error: ${e.message}`);
      return null;
    }
  }

  /**
   * Raw SQL 결과를 프론트엔드 형식으로 변환
   */
  private transformToReportDetailFromRow(
    week: any,
    subRows: any[],
    mgmtData?: {
      quizList: { seq: number; mgmtType: string; title: string; link: string | null; linkTarget: string | null; videoUrl: string | null; postFrom: string | null; postTo: string | null }[];
      channelList: { seq: number; mgmtType: string; title: string; link: string | null; linkTarget: string | null; videoUrl: string | null; postFrom: string | null; postTo: string | null }[];
      porkNewsList: { seq: number; mgmtType: string; title: string; link: string | null; linkTarget: string | null; videoUrl: string | null; postFrom: string | null; postTo: string | null }[];
    },
  ) {
    const subs = subRows.map((row) => this.mapRowToWeekSub(row));

    return {
      header: {
        farmNo: week.FARM_NO,
        farmNm: week.FARM_NM,
        ownerNm: week.OWNER_NM,
        year: week.REPORT_YEAR,
        weekNo: week.REPORT_WEEK_NO,
        period: {
          from: this.formatDate(week.DT_FROM),
          to: this.formatDate(week.DT_TO),
          fromRaw: week.DT_FROM_RAW,  // YYYYMMDD 형식
          toRaw: week.DT_TO_RAW,      // YYYYMMDD 형식
        },
      },
      alertMd: {
        count: week.ALERT_TOTAL || 0,
        euMiCnt: week.ALERT_EU_MI || 0,
        sgMiCnt: week.ALERT_SG_MI || 0,
        bmDelayCnt: week.ALERT_BM_DELAY || 0,
        euDelayCnt: week.ALERT_EU_DELAY || 0,
        items: this.extractSubData(subs, 'ALERT').map((item) => ({
          period: item.code1,
          hubo: item.cnt1,
          euMi: item.cnt2,
          sgMi: item.cnt3,
          bmDelay: item.cnt4,
          euDelay: item.cnt5,
        })),
      },
      lastWeek: {
        period: {
          weekNum: week.REPORT_WEEK_NO,
          from: this.formatDate(week.DT_FROM),
          to: this.formatDate(week.DT_TO),
        },
        modon: {
          regCnt: week.MODON_REG_CNT,
          sangsiCnt: week.MODON_SANGSI_CNT,
          regCntChange: week.MODON_REG_CHG,       // NULL이면 undefined → 증감 표시 안함
          sangsiCntChange: week.MODON_SANGSI_CHG, // NULL이면 undefined → 증감 표시 안함
        },
        mating: {
          cnt: week.LAST_GB_CNT,
          sum: week.LAST_GB_SUM,
        },
        farrowing: {
          cnt: week.LAST_BM_CNT,
          totalCnt: week.LAST_BM_TOTAL,
          liveCnt: week.LAST_BM_LIVE,
          deadCnt: week.LAST_BM_DEAD,
          mummyCnt: week.LAST_BM_MUMMY,
          sumCnt: week.LAST_BM_SUM_CNT,
          sumTotalCnt: week.LAST_BM_SUM_TOTAL,
          sumLiveCnt: week.LAST_BM_SUM_LIVE,
          avgTotal: week.LAST_BM_AVG_TOTAL,
          avgLive: week.LAST_BM_AVG_LIVE,
          sumAvgTotal: week.LAST_BM_SUM_AVG_TOTAL,  // 누계 총산 평균
          sumAvgLive: week.LAST_BM_SUM_AVG_LIVE,    // 누계 실산 평균
          changeTotal: week.LAST_BM_CHG_TOTAL,
          changeLive: week.LAST_BM_CHG_LIVE,
        },
        weaning: {
          cnt: week.LAST_EU_CNT,
          jdCnt: week.LAST_EU_JD_CNT,
          pigletCnt: week.LAST_EU_JD_CNT,  // alias
          avgWeight: week.LAST_EU_AVG_KG,
          avgJdCnt: week.LAST_EU_AVG_JD,      // DB 컬럼에서 직접 (분만 패턴과 동일)
          sumCnt: week.LAST_EU_SUM_CNT,
          sumJdCnt: week.LAST_EU_SUM_JD,
          sumAvgJdCnt: week.LAST_EU_SUM_AVG_JD,  // 누계 평균 이유두수
          changeJdCnt: week.LAST_EU_CHG_JD,   // 평균 이유두수 증감 (1년평균 대비)
          changeWeight: week.LAST_EU_CHG_KG,
        },
        accident: {
          cnt: week.LAST_SG_CNT,
          avgGyungil: week.LAST_SG_AVG_GYUNGIL,        // 지난주 평균 경과일
          sum: week.LAST_SG_SUM,
          sumAvgGyungil: week.LAST_SG_SUM_AVG_GYUNGIL, // 당해년도 평균 경과일
        },
        culling: {
          cnt: week.LAST_CL_CNT,
          sum: week.LAST_CL_SUM,
        },
        shipment: {
          cnt: week.LAST_SH_CNT,
          avg: week.LAST_SH_AVG_KG,
          sum: week.LAST_SH_SUM,
          avgSum: week.LAST_SH_AVG_SUM,
        },
      },
      thisWeek: {
        gbSum: week.THIS_GB_SUM,
        imsinSum: week.THIS_IMSIN_SUM,
        bmSum: week.THIS_BM_SUM,
        euSum: week.THIS_EU_SUM,
        vaccineSum: week.THIS_VACCINE_SUM,
        shipSum: week.THIS_SHIP_SUM,
        schedules: this.extractScheduleData(subs),
        // 캘린더 그리드 데이터 (ThisWeekSection.tsx용)
        calendarGrid: this.extractCalendarGridData(subs, week),
      },
      kpi: {
        psy: week.KPI_PSY,
        delayDay: week.KPI_DELAY_DAY,
        psyX: week.PSY_X,
        psyY: week.PSY_Y,
        psyZone: week.PSY_ZONE,
      },
      // 부가 정보
      extra: {
        psy: {
          zone: mockData.operationSummaryData.psyDelay.zone,
          status: mockData.operationSummaryData.psyDelay.statusLabel,
          value: mockData.operationSummaryData.psyDelay.psy,
          delay: mockData.operationSummaryData.psyDelay.delay,
        },
        price: {
          avg: 0,
          max: 0,
          min: 0,
          source: '전국(제주제외) 탕박 등외제외',
        },
        weather: {
          min: null as number | null,
          max: null as number | null,
          current: null as number | null,
          region: '',
          weatherCd: undefined as string | undefined,
          weatherNm: undefined as string | undefined,
        },
      },
      // 관리 포인트 (TS_INS_MGMT 테이블에서 조회)
      mgmt: mgmtData || { quizList: [], channelList: [], porkNewsList: [] },
      // 금주 작업예정 팝업 데이터 (SCHEDULE_GB, SCHEDULE_BM, SCHEDULE_EU, SCHEDULE_VACCINE)
      scheduleData: this.extractSchedulePopupData(subs),
    };
  }

  /**
   * 금주 작업예정 팝업 데이터 추출
   * GUBUN='SCHEDULE', SUB_GUBUN='GB/BM/EU/VACCINE'
   * 컬럼 매핑:
   *   - STR_1: 예정작업명 (taskNm)
   *   - STR_2: 기준작업코드 (STD_CD) → ComService로 코드명 변환 (PCODE='02')
   *   - STR_3: 대상돈군코드 (MODON_STATUS_CD) → ComService로 코드명 변환 (PCODE='01')
   *   - STR_4: 경과일 (elapsedDays)
   *   - STR_5: 백신명 (백신예정 시)
   *   - CNT_1: 대상복수 합계 (count)
   *   - CNT_2~CNT_8: 요일별 분포 (월~일)
   */
  private extractSchedulePopupData(subs: TsInsWeekSub[]) {
    // 코드 → 코드명 변환 (ComService 캐시 사용)
    const mapToDetailItem = (s: TsInsWeekSub) => {
      // STR_2: 기준작업코드 → 기준작업명 (TC_CODE_SYS PCODE='02')
      const baseTaskCode = s.str2 || '';
      const baseTaskName = baseTaskCode
        ? this.comService.getCodeSysName('02', baseTaskCode) || baseTaskCode
        : '';

      // STR_3: 대상돈군코드 → 대상돈군명 (TC_CODE_SYS PCODE='01')
      const targetGroupCode = s.str3 || '';
      const targetGroupName = targetGroupCode
        ? this.comService.getCodeSysName('01', targetGroupCode) || targetGroupCode
        : '';

      return {
        taskNm: s.str1 || '',
        baseTask: baseTaskName,
        targetGroup: targetGroupName,
        elapsedDays: s.str4 || '',
        count: s.cnt1 || 0,
        // 요일별 분포 (월~일, CNT_2~CNT_8)
        daily: [
          s.cnt2 || 0,  // 월
          s.cnt3 || 0,  // 화
          s.cnt4 || 0,  // 수
          s.cnt5 || 0,  // 목
          s.cnt6 || 0,  // 금
          s.cnt7 || 0,  // 토
          s.cnt8 || 0,  // 일
        ],
      };
    };

    // 교배예정 (GUBUN='SCHEDULE', SUB_GUBUN='GB')
    const gb = subs
      .filter((s) => s.gubun === 'SCHEDULE' && s.subGubun === 'GB')
      .sort((a, b) => (a.sortNo || 0) - (b.sortNo || 0))
      .map(mapToDetailItem);

    // 분만예정 (GUBUN='SCHEDULE', SUB_GUBUN='BM')
    const bm = subs
      .filter((s) => s.gubun === 'SCHEDULE' && s.subGubun === 'BM')
      .sort((a, b) => (a.sortNo || 0) - (b.sortNo || 0))
      .map(mapToDetailItem);

    // 이유예정 (GUBUN='SCHEDULE', SUB_GUBUN='EU')
    const eu = subs
      .filter((s) => s.gubun === 'SCHEDULE' && s.subGubun === 'EU')
      .sort((a, b) => (a.sortNo || 0) - (b.sortNo || 0))
      .map(mapToDetailItem);

    // 백신예정 (GUBUN='SCHEDULE', SUB_GUBUN='VACCINE') - 백신명 추가
    const vaccine = subs
      .filter((s) => s.gubun === 'SCHEDULE' && s.subGubun === 'VACCINE')
      .sort((a, b) => (a.sortNo || 0) - (b.sortNo || 0))
      .map((s) => ({
        ...mapToDetailItem(s),
        vaccineName: s.str5 || '',  // 백신명 추가
      }));

    return { gb, bm, eu, vaccine };
  }

  /**
   * SUB 데이터에서 특정 GUBUN 추출
   */
  private extractSubData(subs: TsInsWeekSub[], gubun: string) {
    return subs
      .filter((s) => s.gubun === gubun)
      .map((s) => ({
        code1: s.code1,
        code2: s.code2,
        cnt1: s.cnt1,
        cnt2: s.cnt2,
        cnt3: s.cnt3,
        cnt4: s.cnt4,
        cnt5: s.cnt5,
        val1: s.val1,
        val2: s.val2,
        str1: s.str1,
        str2: s.str2,
      }));
  }

  /**
   * 예정 작업 데이터 추출
   */
  private extractScheduleData(subs: TsInsWeekSub[]) {
    const scheduleGubuns = [
      'SCHEDULE_GB',
      'SCHEDULE_IMSIN',
      'SCHEDULE_BM',
      'SCHEDULE_EU',
      'SCHEDULE_VACCINE',
      'SCHEDULE_SHIP',
    ];

    const result: Record<string, any[]> = {};
    scheduleGubuns.forEach((gubun) => {
      const key = gubun.replace('SCHEDULE_', '').toLowerCase();
      result[key] = this.extractSubData(subs, gubun);
    });

    return result;
  }

  /**
   * 캘린더 그리드 데이터 추출 (ThisWeekSection.tsx용)
   * GUBUN='SCHEDULE', SUB_GUBUN='-' (요약), SUB_GUBUN='CAL' (캘린더 그리드)
   * @see docs/db/sql/00_SQL_GUIDE.md 10.3 SCHEDULE / SCHEDULE_CAL 상세 매핑
   */
  private extractCalendarGridData(subs: TsInsWeekSub[], week: any) {
    // 요약 데이터 (GUBUN='SCHEDULE', SUB_GUBUN='-')
    const scheduleSub = subs.find((s) => s.gubun === 'SCHEDULE' && s.subGubun === '-');

    // 캘린더 데이터 (GUBUN='SCHEDULE', SUB_GUBUN='CAL', SORT_NO=1~6)
    const calSubs = subs
      .filter((s) => s.gubun === 'SCHEDULE' && s.subGubun === 'CAL')
      .sort((a, b) => (a.sortNo || 0) - (b.sortNo || 0));

    // CODE_1로 각 행 찾기
    const gbRow = calSubs.find((s) => s.code1 === 'GB');
    const bmRow = calSubs.find((s) => s.code1 === 'BM');
    const imsinRow = calSubs.find((s) => s.code1 === 'IMSIN');       // 모돈작업설정: 임신감정 통합
    const imsin3wRow = calSubs.find((s) => s.code1 === 'IMSIN_3W');  // 농장기본값: 재발확인(3주)
    const imsin4wRow = calSubs.find((s) => s.code1 === 'IMSIN_4W');  // 농장기본값: 임신진단(4주)
    const euRow = calSubs.find((s) => s.code1 === 'EU');
    const vaccineRow = calSubs.find((s) => s.code1 === 'VACCINE');

    // 임신감정 산정방식 판단: IMSIN 있으면 모돈작업설정, 없으면 농장기본값
    const isModonPregnancy = !!imsinRow;

    // CNT_1~7을 배열로 변환 (0은 null로)
    const toArray = (row?: TsInsWeekSub): (number | null)[] => {
      if (!row) return [null, null, null, null, null, null, null];
      return [
        row.cnt1 || null,
        row.cnt2 || null,
        row.cnt3 || null,
        row.cnt4 || null,
        row.cnt5 || null,
        row.cnt6 || null,
        row.cnt7 || null,
      ];
    };

    // STR_1~7에서 날짜 추출 (DD 형식)
    const toDates = (row?: TsInsWeekSub): (number | string)[] => {
      if (!row) return [];
      return [
        row.str1 || '',
        row.str2 || '',
        row.str3 || '',
        row.str4 || '',
        row.str5 || '',
        row.str6 || '',
        row.str7 || '',
      ].map((d) => {
        // '01' 같은 문자열은 그대로, 숫자형은 number로
        const num = parseInt(d, 10);
        return isNaN(num) ? d : num;
      });
    };

    // 날짜 배열 추출 (SCHEDULE_CAL 행에서)
    // 모든 행에 날짜가 저장되어 있으므로 첫 번째 유효한 행에서 추출
    let dates = toDates(gbRow || bmRow || imsin3wRow || imsin4wRow || euRow || vaccineRow);

    // SCHEDULE_CAL 데이터가 없는 경우 week 테이블의 DT_TO 기준으로 날짜 생성
    // DT_TO는 지난주 종료일이므로 +1~+7이 금주
    if (dates.length === 0 && week.DT_TO) {
      // DT_TO 형식: 'YY.MM.DD' (API에서 변환됨)
      // 금주 시작일 계산 (DT_TO + 1)
      const dtToStr = week.DT_TO; // e.g., '24.12.15'
      const parts = dtToStr.split('.');
      if (parts.length === 3) {
        const year = 2000 + parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10) - 1;
        const day = parseInt(parts[2], 10);
        const lastWeekEnd = new Date(year, month, day);

        dates = [];
        for (let i = 1; i <= 7; i++) {
          const d = new Date(lastWeekEnd);
          d.setDate(d.getDate() + i);
          dates.push(d.getDate()); // DD만 추출
        }
      }
    }

    // periodFrom/periodTo 계산 (SCHEDULE 데이터 없는 경우 fallback)
    let periodFrom = scheduleSub?.str1 || '';
    let periodTo = scheduleSub?.str2 || '';
    let periodFromRaw = ''; // YYYYMMDD 형식
    let periodToRaw = '';   // YYYYMMDD 형식

    if (!periodFrom && dates.length === 7) {
      // dates[0]과 dates[6]에서 MM.DD 형식 생성
      // week.DT_TO 기반으로 월 계산
      const dtToStr = week.DT_TO;
      const parts = dtToStr?.split('.') || [];
      if (parts.length === 3) {
        const year = 2000 + parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10) - 1;
        const day = parseInt(parts[2], 10);
        const lastWeekEnd = new Date(year, month, day);

        const startDate = new Date(lastWeekEnd);
        startDate.setDate(startDate.getDate() + 1);
        const endDate = new Date(lastWeekEnd);
        endDate.setDate(endDate.getDate() + 7);

        periodFrom = `${String(startDate.getMonth() + 1).padStart(2, '0')}.${String(startDate.getDate()).padStart(2, '0')}`;
        periodTo = `${String(endDate.getMonth() + 1).padStart(2, '0')}.${String(endDate.getDate()).padStart(2, '0')}`;
        periodFromRaw = `${startDate.getFullYear()}${String(startDate.getMonth() + 1).padStart(2, '0')}${String(startDate.getDate()).padStart(2, '0')}`;
        periodToRaw = `${endDate.getFullYear()}${String(endDate.getMonth() + 1).padStart(2, '0')}${String(endDate.getDate()).padStart(2, '0')}`;
      }
    } else if (periodFrom && periodTo) {
      // SCHEDULE 데이터가 있는 경우 RAW 형식 계산
      // periodFrom/To: 'MM.DD' 형식, week.DT_TO_RAW에서 연도 추출
      const yearStr = week.DT_TO_RAW?.substring(0, 4) || String(new Date().getFullYear());
      const fromParts = periodFrom.split('.');
      const toParts = periodTo.split('.');
      if (fromParts.length === 2 && toParts.length === 2) {
        // 연도 넘김 처리: periodFrom이 12월이고 periodTo가 1월이면 연도 증가
        let fromYear = parseInt(yearStr, 10);
        let toYear = fromYear;
        const fromMonth = parseInt(fromParts[0], 10);
        const toMonth = parseInt(toParts[0], 10);
        // DT_TO는 지난주 종료일이므로 금주 시작은 다음날
        // 12월 마지막 주 → 1월 첫 주로 넘어가는 경우
        if (fromMonth === 12 && toMonth === 1) {
          toYear = fromYear + 1;
        } else if (fromMonth === 1) {
          // 금주가 1월이면 연도는 DT_TO_RAW + 1
          fromYear = parseInt(yearStr, 10) + (parseInt(week.DT_TO_RAW?.substring(4, 6) || '12', 10) === 12 ? 1 : 0);
          toYear = fromYear;
        }
        periodFromRaw = `${fromYear}${fromParts[0]}${fromParts[1]}`;
        periodToRaw = `${toYear}${toParts[0]}${toParts[1]}`;
      }
    }

    return {
      // 주차 정보 (SCHEDULE.CNT_7 또는 week 테이블)
      weekNum: scheduleSub?.cnt7 || week.REPORT_WEEK_NO || 0,
      periodFrom,
      periodTo,
      periodFromRaw,  // YYYYMMDD 형식 (날씨 조회용)
      periodToRaw,    // YYYYMMDD 형식 (날씨 조회용)
      // 날짜 배열 (항상 7개)
      dates,
      // 요약 합계 (SCHEDULE 행 또는 week 테이블)
      gbSum: scheduleSub?.cnt1 || week.THIS_GB_SUM || 0,
      imsinSum: scheduleSub?.cnt2 || week.THIS_IMSIN_SUM || 0,
      bmSum: scheduleSub?.cnt3 || week.THIS_BM_SUM || 0,
      euSum: scheduleSub?.cnt4 || week.THIS_EU_SUM || 0,
      vaccineSum: scheduleSub?.cnt5 || week.THIS_VACCINE_SUM || 0,
      shipSum: scheduleSub?.cnt6 || week.THIS_SHIP_SUM || 0,
      // 캘린더 셀 데이터
      gb: toArray(gbRow),
      bm: toArray(bmRow),
      imsin: isModonPregnancy ? toArray(imsinRow) : undefined,    // 모돈작업설정: 임신감정 통합
      imsin3w: !isModonPregnancy ? toArray(imsin3wRow) : undefined, // 농장기본값: 재발확인(3주)
      imsin4w: !isModonPregnancy ? toArray(imsin4wRow) : undefined, // 농장기본값: 임신진단(4주)
      eu: toArray(euRow),
      vaccine: toArray(vaccineRow),
      // 출하는 병합 셀 (합계만)
      ship: scheduleSub?.cnt6 || week.THIS_SHIP_SUM || 0,
      // 임신감정 산정방식 플래그 (true: 모돈작업설정, false: 농장기본값)
      isModonPregnancy,
      // 산출기준 도움말 (GUBUN='SCHEDULE', SUB_GUBUN='HELP')
      help: this.extractScheduleHelpData(subs),
    };
  }

  /**
   * 산출기준 도움말 추출 (GUBUN='SCHEDULE', SUB_GUBUN='HELP')
   * @see SP_INS_WEEK_SCHEDULE_POPUP 11. HELP 정보 INSERT
   */
  private extractScheduleHelpData(subs: TsInsWeekSub[]) {
    const helpSub = subs.find((s) => s.gubun === 'SCHEDULE' && s.subGubun === 'HELP');
    if (!helpSub) return undefined;

    // METHOD row에서 산정방식 직접 조회 (farm/modon)
    // ETL에서 SUB_GUBUN='METHOD'로 별도 저장: STR_1=교배, STR_2=분만, STR_3=임신감정, STR_4=이유, STR_5=백신
    const methodSub = subs.find((s) => s.gubun === 'SCHEDULE' && s.subGubun === 'METHOD');

    return {
      mating: helpSub.str1 || '',        // 교배 산출기준
      farrowing: helpSub.str2 || '',     // 분만 산출기준
      weaning: helpSub.str3 || '',       // 이유 산출기준
      vaccine: helpSub.str4 || '',       // 백신 산출기준
      shipment: helpSub.str5 || '',      // 출하 산출기준
      pregnancy3w: helpSub.str6 || '',   // 재발확인(3주) 산출기준
      pregnancy4w: helpSub.str7 || '',   // 임신진단(4주) 산출기준
      // 모돈작업설정일 때 통합 표시용 (str6, str7 동일한 값)
      pregnancy: helpSub.str6 || '',     // 임신감정 산출기준 (모돈작업설정용)
      // 각 작업별 산정방식 (true: 농장기본값 = 팝업 없음, false: 모돈작업설정 = 팝업 있음)
      // METHOD row에서 직접 method 값 확인 (farm이면 팝업 없음)
      // 교배는 farm 모드여도 팝업 활성화 (이유돈/후보돈/사고재발돈 3가지 기준 표시)
      isFarmMating: false,  // 항상 팝업 활성화
      isFarmFarrowing: methodSub?.str2 === 'farm',
      isFarmWeaning: methodSub?.str4 === 'farm',  // METHOD row: STR_4=이유
      isFarmVaccine: methodSub?.str5 === 'farm',  // METHOD row: STR_5=백신
    };
  }

  /**
   * 날짜 포맷 (YYYY-MM-DD)
   */
  private formatDate(date: Date | string): string {
    if (!date) return '';
    if (typeof date === 'string') {
      return date.substring(0, 10);
    }
    if (date instanceof Date) {
      return date.toISOString().split('T')[0];
    }
    try {
      return new Date(date).toISOString().split('T')[0];
    } catch {
      return String(date);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 팝업 데이터 조회
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * 팝업 데이터 조회
   * @param type 팝업 타입 (alertMd, modon, mating 등)
   * @param masterSeq 마스터 SEQ
   * @param farmNo 농장번호
   */
  async getPopupData(type: string, masterSeq: number, farmNo: number) {
    try {
      // SUB_GUBUN 적용: 단일 GUBUN + SUB_GUBUN으로 구분
      const gubunMap: Record<string, string> = {
        alertMd: 'ALERT_MD',
        modon: 'MODON',           // 모돈현황: MODON (산차별 × 상태별)
        mating: 'GB',             // 교배실적: GB/STAT(요약), GB/CHART(재귀일차트)
        farrowing: 'BM',          // 분만실적: BM(요약)
        weaning: 'EU',            // 이유실적: EU(요약)
        accident: 'SG',           // 임신사고: SG/STAT(원인별), SG/CHART(임신일차트)
        culling: 'DOPE',          // 도태폐사: DOPE/STAT(요약), DOPE/LIST(원인별), DOPE/CHART(상태별)
        shipment: 'SHIP',         // 출하실적: SHIP/STAT(요약), SHIP/ROW(크로스탭), SHIP/CHART(차트), SHIP/SCATTER(산점도)
        schedule: 'SCHEDULE',     // 작업예정: SCHEDULE/-,CAL,GB,BM,EU,VACCINE
      };

      const gubun = gubunMap[type];
      if (!gubun) {
        return null;
      }

      // SUB_GUBUN 구조로 변경: 항상 단일 GUBUN으로 조회
      const results = await this.dataSource.query(WEEKLY_SQL.getPopupSub, params({
        masterSeq,
        farmNo,
        gubun,
      }));

      const subs = results.map((row: any) => this.mapRowToWeekSub(row));
      return this.transformPopupData(type, subs);
    } catch (error) {
      this.logger.error(`팝업 데이터 조회 실패: ${type}`, error.message);
      // DB 연동 완료 - Mock fallback 제거
      return null;
    }
  }

  /**
   * Raw SQL 결과 Row를 TsInsWeekSub 형식으로 매핑
   */
  private mapRowToWeekSub(row: any): TsInsWeekSub {
    const sub = new TsInsWeekSub();
    sub.masterSeq = row.MASTER_SEQ;
    sub.farmNo = row.FARM_NO;
    sub.gubun = row.GUBUN;
    sub.subGubun = row.SUB_GUBUN || '-';
    sub.sortNo = row.SORT_NO;
    sub.code1 = row.CODE_1;
    sub.code2 = row.CODE_2;
    // CNT_1 ~ CNT_15
    sub.cnt1 = row.CNT_1;
    sub.cnt2 = row.CNT_2;
    sub.cnt3 = row.CNT_3;
    sub.cnt4 = row.CNT_4;
    sub.cnt5 = row.CNT_5;
    sub.cnt6 = row.CNT_6;
    sub.cnt7 = row.CNT_7;
    sub.cnt8 = row.CNT_8;
    sub.cnt9 = row.CNT_9;
    sub.cnt10 = row.CNT_10;
    sub.cnt11 = row.CNT_11;
    sub.cnt12 = row.CNT_12;
    sub.cnt13 = row.CNT_13;
    sub.cnt14 = row.CNT_14;
    sub.cnt15 = row.CNT_15;
    // VAL_1 ~ VAL_15
    sub.val1 = row.VAL_1;
    sub.val2 = row.VAL_2;
    sub.val3 = row.VAL_3;
    sub.val4 = row.VAL_4;
    sub.val5 = row.VAL_5;
    sub.val6 = row.VAL_6;
    sub.val7 = row.VAL_7;
    sub.val8 = row.VAL_8;
    sub.val9 = row.VAL_9;
    sub.val10 = row.VAL_10;
    sub.val11 = row.VAL_11;
    sub.val12 = row.VAL_12;
    sub.val13 = row.VAL_13;
    sub.val14 = row.VAL_14;
    sub.val15 = row.VAL_15;
    sub.str1 = row.STR_1;
    sub.str2 = row.STR_2;
    sub.str3 = row.STR_3;
    sub.str4 = row.STR_4;
    sub.str5 = row.STR_5;
    sub.str6 = row.STR_6;
    sub.str7 = row.STR_7;
    sub.str8 = row.STR_8;
    sub.str9 = row.STR_9;
    sub.str10 = row.STR_10;
    sub.str11 = row.STR_11;
    sub.str12 = row.STR_12;
    sub.str13 = row.STR_13;
    sub.str14 = row.STR_14;
    sub.str15 = row.STR_15;
    // HINT1 ~ HINT3
    sub.hint1 = row.HINT1;
    sub.hint2 = row.HINT2;
    sub.hint3 = row.HINT3;
    // JSON_DATA (CLOB)
    sub.jsonData = row.JSON_DATA;
    return sub;
  }

  /**
   * 팝업 데이터 변환
   */
  private transformPopupData(type: string, subs: TsInsWeekSub[]) {
    switch (type) {
      case 'alertMd':
        return this.transformAlertMdPopup(subs);
      case 'modon':
        return this.transformParityDistPopup(subs);
      case 'mating':
        return this.transformMatingPopup(subs);
      case 'farrowing':
        return this.transformFarrowingPopup(subs);
      case 'weaning':
        return this.transformWeaningPopup(subs);
      case 'accident':
        return this.transformAccidentPopup(subs);
      case 'culling':
        return this.transformCullingPopup(subs);
      case 'shipment':
        return this.transformShipmentPopup(subs);
      case 'schedule':
        return this.transformSchedulePopup(subs);
      default:
        return subs;
    }
  }

  private transformAlertMdPopup(subs: TsInsWeekSub[]) {
    return subs.map((s) => ({
      category: s.code1,
      modonNo: s.str1,
      status: s.str2,
      days: s.cnt1,
      parity: s.cnt2,
    }));
  }

  /**
   * 모돈현황 팝업 데이터 변환
   * GUBUN: MODON
   * DB 구조: CODE1=산차(후보돈,0산~8산↑), CNT1~5=후보/임신/포유/이유모/사고, CNT6=증감
   * 원본 SQL: 상태별(행) × 산차별(열) → 피벗하여 산차별(행) × 상태별(열)로 저장
   * @returns ModonPopupData 형식
   */
  private transformParityDistPopup(subs: TsInsWeekSub[]) {
    // 기본 산차 정의: 후보돈 + 0산~8산↑ (원본 SQL 기준: M0~M8)
    const defaultParities = [
      { parity: '후보돈', group: 'hubo' as const },
      { parity: '0산', group: 'current' as const },
      { parity: '1산', group: 'current' as const },
      { parity: '2산', group: 'current' as const },
      { parity: '3산', group: 'current' as const },
      { parity: '4산', group: 'current' as const },
      { parity: '5산', group: 'current' as const },
      { parity: '6산', group: 'current' as const },
      { parity: '7산', group: 'current' as const },
      { parity: '8산↑', group: 'current' as const },
    ];

    // DB 데이터를 Map으로 변환 (CODE1 기준)
    const dataMap = new Map<string, TsInsWeekSub>();
    subs.forEach((s) => {
      if (s.code1) {
        dataMap.set(s.code1, s);
      }
    });

    // 테이블 데이터: 기본 산차 기준으로 생성, 데이터 없으면 null 처리
    const table = defaultParities.map(({ parity, group }) => {
      const data = dataMap.get(parity);
      if (data) {
        return {
          parity,
          hubo: data.cnt1 ?? null,
          imsin: data.cnt2 ?? null,
          poyu: data.cnt3 ?? null,
          eumo: data.cnt4 ?? null,
          sago: data.cnt5 ?? null,
          change: data.cnt6 ?? null,
          group,
        };
      }
      // 데이터 없으면 모두 null (프론트엔드에서 '-' 표시)
      return {
        parity,
        hubo: null,
        imsin: null,
        poyu: null,
        eumo: null,
        sago: null,
        change: null,
        group,
      };
    });

    // 차트 데이터: 산차별 두수 (전체 합계), 데이터 없으면 0
    const chart = {
      xAxis: defaultParities.map((p) => p.parity),
      data: defaultParities.map(({ parity }) => {
        const data = dataMap.get(parity);
        if (data) {
          return (data.cnt1 || 0) + (data.cnt2 || 0) + (data.cnt3 || 0) + (data.cnt4 || 0) + (data.cnt5 || 0);
        }
        return 0;
      }),
    };

    return { table, chart };
  }

  /**
   * 교배실적 팝업 데이터 변환
   * GUBUN='GB', SUB_GUBUN='STAT' (요약통계), SUB_GUBUN='CHART' (재귀일별 차트)
   *
   * GB/STAT 컬럼 매핑:
   *   - CNT_1: 합계 실적
   *   - CNT_2: 교배도중 사고복수
   *   - CNT_3: 교배도중 분만복수
   *   - CNT_4: 초교배복수 실적
   *   - CNT_5: 재발교배복수 실적 (GYOBAE_CNT>1)
   *   - CNT_6: 정상교배복수 실적 (초교배 제외, GYOBAE_CNT=1)
   *   - CNT_7: 초교배 예정복수
   *   - CNT_8: 정상교배 예정복수
   *   - CNT_9: 재발교배 예정복수
   *   - VAL_1: 평균 재귀발정일
   *   - VAL_2: 평균 초교배일
   *
   * GB/CHART 컬럼 매핑 (1 ROW 형식):
   *   - CNT_1~CNT_8: 재귀일별 (~3일, 4일, 5일, 6일, 7일, 8일, 9일, 10일↑)
   *
   * @returns MatingPopupData 형식
   */
  private transformMatingPopup(subs: TsInsWeekSub[]) {
    // 요약 통계 데이터 (GUBUN='GB', SUB_GUBUN='STAT')
    const statSub = subs.find((s) => s.gubun === 'GB' && s.subGubun === 'STAT');

    // 유형별 테이블 데이터 생성 (초교배, 정상교배, 재발교배)
    const table: { type: string; planned: number; actual: number; rate: string }[] = [];

    if (statSub) {
      // 초교배복수
      const huboPlan = statSub.cnt7 || 0;
      const huboActual = statSub.cnt4 || 0;
      table.push({
        type: '초교배',
        planned: huboPlan,
        actual: huboActual,
        rate: huboPlan > 0 ? ((huboActual / huboPlan) * 100).toFixed(1) + '%' : '-',
      });

      // 정상교배복수
      const normalPlan = statSub.cnt8 || 0;
      const normalActual = statSub.cnt6 || 0;
      table.push({
        type: '정상교배',
        planned: normalPlan,
        actual: normalActual,
        rate: normalPlan > 0 ? ((normalActual / normalPlan) * 100).toFixed(1) + '%' : '-',
      });

      // 재발교배복수
      const sagoPlan = statSub.cnt9 || 0;
      const sagoActual = statSub.cnt5 || 0;
      table.push({
        type: '재발교배',
        planned: sagoPlan,
        actual: sagoActual,
        rate: sagoPlan > 0 ? ((sagoActual / sagoPlan) * 100).toFixed(1) + '%' : '-',
      });
    }

    // 합계 계산
    const totalPlanned = table.reduce((sum, row) => sum + row.planned, 0);
    const totalActual = statSub?.cnt1 || table.reduce((sum, row) => sum + row.actual, 0);
    const total = {
      planned: totalPlanned,
      actual: totalActual,
      rate: totalPlanned > 0 ? ((totalActual / totalPlanned) * 100).toFixed(1) + '%' : '-',
    };

    // 재귀일별 차트 데이터 (GUBUN='GB', SUB_GUBUN='CHART')
    // 1 ROW 형식: CNT_1~CNT_8 = 재귀일별 (~3일, 4일, 5일, 6일, 7일, 8일, 9일, 10일↑)
    const chartSub = subs.find((s) => s.gubun === 'GB' && s.subGubun === 'CHART');
    const chartLabels = ['~3', '4', '5', '6', '7', '8', '9', '10↑'];
    const chartData = chartLabels.map((_, i) => {
      const cntKey = `cnt${i + 1}` as keyof TsInsWeekSub;
      return (chartSub?.[cntKey] as number) || 0;
    });
    const chart = {
      xAxis: chartLabels,
      data: chartData,
    };

    // 요약 정보 (GB_STAT)
    const summary = statSub ? {
      totalActual: statSub.cnt1 || 0,       // CNT_1: 합계 실적
      totalPlanned: (statSub.cnt7 || 0) + (statSub.cnt8 || 0),  // 예정 합계 (초교배 + 정상교배)
      accidentCnt: statSub.cnt2 || 0,       // CNT_2: 교배도중 사고복수
      farrowingCnt: statSub.cnt3 || 0,      // CNT_3: 교배도중 분만복수
      avgReturnDay: statSub.val1 || 0,      // VAL_1: 평균 재귀발정일
      avgFirstGbDay: statSub.val2 || 0,     // VAL_2: 평균 초교배일
      firstGbCnt: statSub.cnt4 || 0,        // CNT_4: 초교배복수 실적
      firstGbPlanned: statSub.cnt7 || 0,    // CNT_7: 초교배 예정복수
      jsGbCnt: statSub.cnt6 || 0,           // CNT_6: 정상교배복수 실적
      jsGbPlanned: statSub.cnt8 || 0,       // CNT_8: 정상교배 예정복수
      sagoGbCnt: statSub.cnt5 || 0,         // CNT_5: 재발교배복수 실적 (예정 없음)
    } : undefined;

    // 힌트 메시지 - 예정 산출기준 설명
    // 기존: 별도 SUB_GUBUN='HINT' ROW → 변경: STAT ROW의 HINT1 컬럼
    const hint = statSub?.hint1 || undefined;

    return { table, total, chart, summary, hint };
  }

  /**
   * 분만실적 팝업 데이터 변환
   * GUBUN: BM (요약통계)
   *
   * BM 컬럼 매핑:
   *   - CNT_1: 분만복수 (실적)
   *   - CNT_2: 총산 합계
   *   - CNT_3: 실산 합계
   *   - CNT_4: 사산 합계
   *   - CNT_5: 미라 합계
   *   - CNT_6: 포유개시 합계
   *   - CNT_7: 분만복수 (예정)
   *   - CNT_8: 생시도태 합계
   *   - CNT_9: 양자 합계 (전입-전출)
   *   - VAL_1: 총산 평균
   *   - VAL_2: 실산 평균
   *   - VAL_3: 사산 평균
   *   - VAL_4: 미라 평균
   *   - VAL_5: 포유개시 평균
   *   - VAL_6: 생시도태 평균
   *   - VAL_7: 양자 평균
   *
   * @returns FarrowingPopupData 형식
   */
  private transformFarrowingPopup(subs: TsInsWeekSub[]) {
    // 요약 통계 데이터 (BM)
    const statSub = subs.find((s) => s.gubun === 'BM');

    const planned = statSub?.cnt7 || 0;
    const actual = statSub?.cnt1 || 0;
    const rate = planned > 0 ? ((actual / planned) * 100).toFixed(1) + '%' : '-';

    const totalBornSum = statSub?.cnt2 || 0;
    const bornAliveSum = statSub?.cnt3 || 0;
    const calcRate = (val: number) => (totalBornSum > 0 ? ((val / totalBornSum) * 100).toFixed(1) + '%' : '-');
    // 생시도태, 양자 비율은 실산 대비로 계산
    const calcRateVsLive = (val: number) => (bornAliveSum > 0 ? ((val / bornAliveSum) * 100).toFixed(1) + '%' : '-');

    return {
      planned,
      actual,
      rate,
      stats: {
        totalBorn: {
          sum: totalBornSum,
          avg: statSub?.val1 || 0,
        },
        bornAlive: {
          sum: bornAliveSum,
          avg: statSub?.val2 || 0,
          rate: calcRate(bornAliveSum),
        },
        stillborn: {
          sum: statSub?.cnt4 || 0,
          avg: statSub?.val3 || 0,
          rate: calcRate(statSub?.cnt4 || 0),
        },
        mummy: {
          sum: statSub?.cnt5 || 0,
          avg: statSub?.val4 || 0,
          rate: calcRate(statSub?.cnt5 || 0),
        },
        culling: {
          sum: statSub?.cnt8 || 0,  // CNT_8: 생시도태 합계
          avg: statSub?.val6 || 0,  // VAL_6: 생시도태 평균
          rate: calcRateVsLive(statSub?.cnt8 || 0),
        },
        foster: {
          sum: statSub?.cnt9 || 0,  // CNT_9: 양자 합계 (전입-전출)
          avg: statSub?.val7 || 0,  // VAL_7: 양자 평균
          rate: calcRateVsLive(statSub?.cnt9 || 0),
        },
        nursingStart: {
          sum: statSub?.cnt6 || 0,
          avg: statSub?.val5 || 0, // VAL_5: 포유개시 평균 (DB에서 직접 계산)
          rate: calcRate(statSub?.cnt6 || 0),
        },
      },
      // 힌트 메시지 - 예정 산출기준 설명
      // 기존: 별도 SUB_GUBUN='HINT' ROW → 변경: STAT ROW의 HINT1 컬럼
      hint: statSub?.hint1 || undefined,
    };
  }

  /**
   * 이유실적 팝업 데이터 변환
   * GUBUN: EU (요약통계)
   *
   * EU 컬럼 매핑:
   *   - CNT_1: 이유복수 (실적)
   *   - CNT_2: 이유두수 합계
   *   - CNT_3: 실산 합계
   *   - CNT_4: 포유기간 합계
   *   - CNT_5: 이유복수 (예정)
   *   - CNT_6: 포유자돈폐사 두수 (160001)
   *   - CNT_7: 부분이유 두수 (160002)
   *   - CNT_8: 양자전입 두수 (160003)
   *   - CNT_9: 양자전출 두수 (160004)
   *   - VAL_1: 이유두수 평균
   *   - VAL_2: 평균체중 (가중평균)
   *   - VAL_3: 이유육성율 (이유두수/실산 * 100)
   *   - VAL_4: 평균 포유기간
   *
   * @returns WeaningPopupData 형식
   */
  private transformWeaningPopup(subs: TsInsWeekSub[]) {
    // 요약 통계 데이터 (EU)
    const statSub = subs.find((s) => s.gubun === 'EU');

    const planned = statSub?.cnt5 || 0;   // CNT_5: 이유복수 (예정)
    const actual = statSub?.cnt1 || 0;    // CNT_1: 이유복수 (실적)
    const rate = planned > 0 ? ((actual / planned) * 100).toFixed(1) + '%' : '-';

    // 분만 기준 데이터 (이유 대상 모돈의 분만 정보)
    const totalBirth = parseInt(statSub?.str1 || '0', 10);  // STR_1: 총산 합계
    const liveBirth = statSub?.cnt3 || 0;                   // CNT_3: 실산 합계
    const nursingStart = statSub?.val5 || 0;               // VAL_5: 포유개시 합계

    return {
      planned,
      actual,
      rate,
      // 분만 기준 카드 (이유 대상 모돈의 분만 정보)
      farrowingBased: {
        totalBirth,     // 총산 합계 (실산+사산+미라)
        liveBirth,      // 실산 합계
        nursingStart,   // 포유개시 합계 (실산-폐사+전입-전출)
      },
      stats: {
        weanPigs: {
          sum: statSub?.cnt2 || 0,        // CNT_2: 이유두수 합계
          avg: statSub?.val1 || 0,        // VAL_1: 이유두수 평균
        },
        nursingDays: {
          sum: statSub?.cnt4 || 0,        // CNT_4: 포유기간 합계
          avg: statSub?.val4 || 0,        // VAL_4: 평균 포유기간
        },
        avgWeight: {
          avg: statSub?.val2 || 0,        // VAL_2: 평균체중 (가중평균)
        },
        survivalRate: {
          rate: statSub?.val3 ? statSub.val3.toFixed(1) + '%' : '-',  // VAL_3: 이유육성율 (이유두수/실산)
        },
        nursingStart: {
          sum: nursingStart,              // VAL_5: 포유개시 합계
        },
      },
      // 포유 기간 중 자돈 증감 내역
      pigletChanges: {
        dead: statSub?.cnt6 || 0,         // CNT_6: 포유자돈폐사 (160001)
        partialWean: statSub?.cnt7 || 0,  // CNT_7: 부분이유 (160002)
        fosterIn: statSub?.cnt8 || 0,     // CNT_8: 양자전입 (160003)
        fosterOut: statSub?.cnt9 || 0,    // CNT_9: 양자전출 (160004)
      },
      // 힌트 메시지 - 예정 산출기준 설명
      // 기존: 별도 SUB_GUBUN='HINT' ROW → 변경: STAT ROW의 HINT1 컬럼
      hint: statSub?.hint1 || undefined,
    };
  }

  /**
   * 임신사고 팝업 데이터 변환
   * GUBUN='SG', SUB_GUBUN='STAT' (원인별 - SORT_NO=1:지난주, 2:최근1개월), SUB_GUBUN='CHART' (임신일별 차트)
   * CNT_1~8: 사고구분별 복수 (재발,불임,공태,유산,도태,폐사,임돈전출,임돈판매)
   * VAL_1~8: 사고구분별 비율 (%)
   * @returns AccidentPopupData 형식
   */
  private transformAccidentPopup(subs: TsInsWeekSub[]) {
    // 사고구분명 매핑
    const typeNames = ['재발', '불임', '공태', '유산', '도태', '폐사', '임돈전출', '임돈판매'];

    // 원인별 테이블 데이터 (GUBUN='SG', SUB_GUBUN='STAT': SORT_NO=1:지난주, SORT_NO=2:최근1개월)
    const lastWeekSub = subs.find((s) => s.gubun === 'SG' && s.subGubun === 'STAT' && s.sortNo === 1);
    const lastMonthSub = subs.find((s) => s.gubun === 'SG' && s.subGubun === 'STAT' && s.sortNo === 2);

    const table = typeNames.map((type, i) => {
      const cntKey = `cnt${i + 1}` as keyof TsInsWeekSub;
      const valKey = `val${i + 1}` as keyof TsInsWeekSub;
      return {
        type,
        lastWeek: (lastWeekSub?.[cntKey] as number) || 0,
        lastWeekPct: (lastWeekSub?.[valKey] as number) || 0,
        lastMonth: (lastMonthSub?.[cntKey] as number) || 0,
        lastMonthPct: (lastMonthSub?.[valKey] as number) || 0,
      };
    });

    // 임신일별 차트 데이터 (GUBUN='SG', SUB_GUBUN='CHART': CNT_1~8 = 임신일 범위별 복수)
    const chartSub = subs.find((s) => s.gubun === 'SG' && s.subGubun === 'CHART');
    const chartLabels = ['~7', '8~10', '11~15', '16~20', '21~35', '36~40', '41~45', '46~'];
    const chartData = chartLabels.map((_, i) => {
      const cntKey = `cnt${i + 1}` as keyof TsInsWeekSub;
      return (chartSub?.[cntKey] as number) || 0;
    });

    const chart = {
      xAxis: chartLabels,
      data: chartData,
    };

    return { table, chart };
  }

  /**
   * 도태폐사 팝업 데이터 변환
   * GUBUN='DOPE', SUB_GUBUN='STAT' (유형요약), SUB_GUBUN='LIST' (원인별 15개씩 피벗), SUB_GUBUN='CHART' (상태별)
   * DB 구조:
   *   - DOPE/STAT SORT_NO=1: CNT_1~4=도태/폐사/전출/판매 (지난주)
   *   - DOPE/LIST SORT_NO=1,2...: STR_1~15=원인코드, CNT_1~15=지난주, VAL_1~15=최근1개월
   *   - DOPE/CHART: CNT_1~6=상태별 (후보돈/이유모돈/임신돈/포유돈/사고돈/비생산돈)
   * 원인코드→코드명 변환: ComService 캐시 사용 (TC_CODE_JOHAP PCODE='031')
   * @returns CullingPopupData 형식
   */
  private transformCullingPopup(subs: TsInsWeekSub[]) {
    // 유형별 요약 (GUBUN='DOPE', SUB_GUBUN='STAT', SORT_NO=1: 지난주)
    const summarySub = subs.find((s) => s.gubun === 'DOPE' && s.subGubun === 'STAT' && s.sortNo === 1);
    const stats = {
      dotae: summarySub?.cnt1 || 0,
      dead: summarySub?.cnt2 || 0,
      transfer: summarySub?.cnt3 || 0,
      sale: summarySub?.cnt4 || 0,
    };

    // 원인별 테이블 데이터 (GUBUN='DOPE', SUB_GUBUN='LIST', SORT_NO=1,2,...)
    // STR_1~15: 원인코드, CNT_1~15: 지난주, VAL_1~15: 최근1개월
    const tableSubs = subs.filter((s) => s.gubun === 'DOPE' && s.subGubun === 'LIST');
    const tableRaw: { reasonCd: string; lastWeek: number; lastMonth: number }[] = [];

    for (const sub of tableSubs) {
      // 15개 슬롯을 순회하며 원인코드가 있는 것만 추가
      for (let i = 1; i <= 15; i++) {
        const reasonCd = sub[`str${i}` as keyof TsInsWeekSub] as string;
        if (reasonCd) {
          tableRaw.push({
            reasonCd,
            lastWeek: (sub[`cnt${i}` as keyof TsInsWeekSub] as number) || 0,
            lastMonth: (sub[`val${i}` as keyof TsInsWeekSub] as number) || 0,
          });
        }
      }
    }

    // 원인코드를 코드명으로 변환 (TC_CODE_JOHAP PCODE='031', 캐시 사용)
    // lang 파라미터 생략 시 환경변수 DEFAULT_LANG 사용
    const table = tableRaw.map((r) => ({
      reason: this.comService.getCodeJohapName('031', r.reasonCd) || r.reasonCd,
      lastWeek: r.lastWeek,
      lastMonth: r.lastMonth,
    }));

    // 상태별 차트 데이터 (GUBUN='DOPE', SUB_GUBUN='CHART')
    // STR_1~7: 상태코드 (TC_CODE_SYS PCODE='01')
    // CNT_1~7: 상태별 두수
    // 010001=후보돈, 010002=임신돈, 010003=포유돈, 010004=대리모돈,
    // 010005=이유모돈, 010006=재발돈, 010007=유산돈
    const chartSub = subs.find((s) => s.gubun === 'DOPE' && s.subGubun === 'CHART');

    // 상태코드 배열 (STR_1~7)
    const statusCodes = [
      chartSub?.str1,
      chartSub?.str2,
      chartSub?.str3,
      chartSub?.str4,
      chartSub?.str5,
      chartSub?.str6,
      chartSub?.str7,
    ].filter(Boolean) as string[];

    // 상태코드 → 코드명 변환 (TC_CODE_SYS PCODE='01')
    const xAxis = statusCodes.map(
      (code) => this.comService.getCodeSysName('01', code) || code,
    );

    // 차트 데이터 (값이 있는 것만)
    const chartData: { status: string; statusCd: string; count: number }[] = [];
    for (let i = 1; i <= 7; i++) {
      const statusCd = chartSub?.[`str${i}` as keyof TsInsWeekSub] as string;
      const count = (chartSub?.[`cnt${i}` as keyof TsInsWeekSub] as number) || 0;
      if (statusCd) {
        chartData.push({
          status: this.comService.getCodeSysName('01', statusCd) || statusCd,
          statusCd,
          count,
        });
      }
    }

    const chart = {
      xAxis,
      data: chartData.map((d) => d.count),
      items: chartData, // 프론트엔드에서 상세 정보 사용 가능
    };

    return { stats, table, chart };
  }

  /**
   * 출하실적 팝업 데이터 변환
   * GUBUN='SHIP', SUB_GUBUN='STAT' (요약), SUB_GUBUN='ROW' (크로스탭 15행), SUB_GUBUN='CHART' (분석차트), SUB_GUBUN='SCATTER' (산점도)
   * @see docs/db/ins/week/41.shipment-popup.md
   * @returns ShipmentPopupData 형식 (3탭: 출하현황/출하분석/도체분포)
   */
  private transformShipmentPopup(subs: TsInsWeekSub[]) {
    // ── 1. 요약 통계 (GUBUN='SHIP', SUB_GUBUN='STAT') ──
    const statSub = subs.find((s) => s.gubun === 'SHIP' && s.subGubun === 'STAT');

    // ★ 합격율 평균은 SHIP/ROW의 SORT_NO=4 (ONE_RATIO) 행의 VAL_3에서 가져옴
    //    테이블의 "1등급 > 합격율 > 평균" 값과 동일하게 표시
    const oneRatioRow = subs.find((s) => s.gubun === 'SHIP' && s.subGubun === 'ROW' && s.sortNo === 4);

    const stats = {
      totalCount: statSub?.cnt1 || 0, // 지난주 출하두수
      yearTotal: statSub?.cnt2 || 0, // 당해년도 누계
      grade1Cnt: statSub?.cnt3 || 0, // 1등급+ 합격두수
      grade1Rate: oneRatioRow?.val3 || statSub?.val1 || 0, // 1등급+ 합격율(%): ROW의 평균값 우선
      avgCarcass: statSub?.val2 || 0, // 평균 도체중(kg)
      avgBackfat: statSub?.val3 || 0, // 평균 등지방(mm)
      farmPrice: statSub?.val4 || 0,  // 내농장 평균 단가
      nationalPrice: statSub?.val5 || 0, // 전국 탕박 평균 단가
      // 육성율 산출기준 설정값
      shipDay: statSub?.cnt4 || 180, // 기준출하일령 (기본 180일)
      weanPeriod: statSub?.cnt5 || 21, // 평균포유기간 (기본 21일)
      euDays: statSub?.cnt6 || 159, // 역산일 (shipDay - weanPeriod)
      euDateFrom: statSub?.str1 || '', // 이유일 FROM (MM.DD)
      euDateTo: statSub?.str2 || '', // 이유일 TO (MM.DD)
    };

    // ── 2. 크로스탭 테이블 (SHIP_ROW, 13행) ──
    // 항목 정의 (SQL ROW_DEF와 매핑)
    const rowDefs: {
      sortNo: number;
      category: string;
      sub: string;
      colspan?: boolean;
      highlight?: 'primary' | 'success';
      unit?: string;
      gradeRow?: boolean;
    }[] = [
        { sortNo: 1, category: '출하두수', sub: '두', colspan: true, highlight: 'primary' },
        { sortNo: 2, category: '이유두수', sub: '두', colspan: true },
        { sortNo: 3, category: '육성율', sub: '%', colspan: true },
        { sortNo: 4, category: '1등급', sub: '합격율' },
        { sortNo: 5, category: '등급', sub: '1+', gradeRow: true },
        { sortNo: 6, category: '', sub: '1', gradeRow: true },
        { sortNo: 7, category: '', sub: '2', gradeRow: true },
        { sortNo: 8, category: '성별', sub: '암', gradeRow: true },
        { sortNo: 9, category: '', sub: '수', gradeRow: true },
        { sortNo: 10, category: '', sub: '거세', gradeRow: true },
        { sortNo: 11, category: '총지육', sub: '체중(Kg)' },
        { sortNo: 12, category: '두당평균', sub: '지육체중(Kg)', highlight: 'success' },
        { sortNo: 13, category: '', sub: '등지방두께', highlight: 'success' },
      ];

    // DB 데이터를 Map으로 변환 (GUBUN='SHIP', SUB_GUBUN='ROW')
    const rowMap = new Map<number, TsInsWeekSub>();
    subs
      .filter((s) => s.gubun === 'SHIP' && s.subGubun === 'ROW')
      .forEach((s) => rowMap.set(s.sortNo || 0, s));

    // 날짜 배열 (첫 번째 행에서 추출)
    const firstRow = rowMap.get(1);
    const days = [
      firstRow?.str1,
      firstRow?.str2,
      firstRow?.str3,
      firstRow?.str4,
      firstRow?.str5,
      firstRow?.str6,
      firstRow?.str7,
    ].filter((d) => d) as string[];

    // 테이블 행 생성 (null/0은 프론트에서 '-' 표시)
    // VAL_1: 합계, VAL_2: 비율(%), VAL_3: 평균
    const tableRows = rowDefs.map((def) => {
      const row = rowMap.get(def.sortNo);
      return {
        category: def.category,
        sub: def.sub,
        colspan: def.colspan,
        highlight: def.highlight,
        unit: def.unit,
        gradeRow: def.gradeRow === true,  // 명시적으로 boolean 변환
        data: [
          row?.cnt1 ?? null,
          row?.cnt2 ?? null,
          row?.cnt3 ?? null,
          row?.cnt4 ?? null,
          row?.cnt5 ?? null,
          row?.cnt6 ?? null,
          row?.cnt7 ?? null,
        ].slice(0, days.length),
        sum: row?.val1 ?? null,
        rate: row?.val2 ?? null,  // 비율(%) - 등급/성별 행
        avg: row?.val3 ?? null,   // 평균 - 모든 행
      };
    });

    // 등급차트용 데이터 추출 (1+, 1, 2 등급) - SORT_NO: 5,6,7
    const q11Row = rowMap.get(5);
    const q1Row = rowMap.get(6);
    const q2Row = rowMap.get(7);
    const gradeChart = [
      {
        name: '1+',
        value: q11Row?.val1 || 0,
        color: '#667eea',
        colorEnd: '#764ba2',
      },
      { name: '1', value: q1Row?.val1 || 0, color: '#4ade80', colorEnd: '#22c55e' },
      { name: '2', value: q2Row?.val1 || 0, color: '#94a3b8', colorEnd: '#64748b' },
    ];
    // 등외 (전체 - 1+ - 1 - 2)
    const gradeOutCnt =
      stats.totalCount -
      (q11Row?.val1 || 0) -
      (q1Row?.val1 || 0) -
      (q2Row?.val1 || 0);
    if (gradeOutCnt > 0) {
      gradeChart.push({
        name: '등외',
        value: gradeOutCnt,
        color: '#f87171',
        colorEnd: '#ef4444',
      });
    }

    // ── 3. 분석 차트 (GUBUN='SHIP', SUB_GUBUN='CHART', 7행) ──
    const chartSubs = subs
      .filter((s) => s.gubun === 'SHIP' && s.subGubun === 'CHART')
      .sort((a, b) => (a.sortNo || 0) - (b.sortNo || 0));
    const analysisChart = {
      dates: chartSubs.map((s) => s.str1 || ''),
      shipCount: chartSubs.map((s) => s.cnt1 || 0),
      avgWeight: chartSubs.map((s) => s.val1 || 0),
      avgBackfat: chartSubs.map((s) => s.val2 || 0),
    };

    // ── 4. 산점도 (GUBUN='SHIP', SUB_GUBUN='SCATTER') ──
    // 신규 형식: 1 ROW, JSON_DATA에 JSON 배열 저장 [{"x":도체중, "y":등지방, "cnt":두수}, ...]
    // 기존 형식: N ROW, VAL_1=도체중, VAL_2=등지방, CNT_1=두수
    const scatterSubs = subs.filter((s) => s.gubun === 'SHIP' && s.subGubun === 'SCATTER');
    let carcassData: Array<[number, number, number]> = [];

    if (scatterSubs.length === 1 && scatterSubs[0].jsonData) {
      // 신규 형식: JSON 파싱
      try {
        const parsed = JSON.parse(scatterSubs[0].jsonData);
        carcassData = parsed.map((p: { x: number; y: number; cnt: number }) => [p.x, p.y, p.cnt]);
      } catch {
        carcassData = [];
      }
    } else {
      // 기존 형식: 각 ROW에서 추출 (하위호환)
      carcassData = scatterSubs.map((s) => [s.val1 || 0, s.val2 || 0, s.cnt1 || 0]);
    }

    const carcassChart = {
      data: carcassData,
    };

    // 프론트엔드 인터페이스에 맞게 반환
    // metrics 형태로 변환 (ShipmentPopup.tsx 호환)
    return {
      metrics: {
        totalCount: stats.totalCount,
        compareLastWeek: '-', // 프로시저에서 미지원 (향후 추가 가능)
        grade1Rate: stats.grade1Rate,
        avgCarcass: stats.avgCarcass,
        avgBackfat: stats.avgBackfat,
        farmPrice: stats.farmPrice,
        nationalPrice: stats.nationalPrice,
      },
      // 육성율 산출기준 설정값 (툴팁용)
      rearingConfig: {
        shipDay: stats.shipDay,       // 기준출하일령 (기본 180일)
        weanPeriod: stats.weanPeriod, // 평균포유기간 (기본 21일)
        euDays: stats.euDays,         // 역산일 (shipDay - weanPeriod)
        euDateFrom: stats.euDateFrom, // 이유일 FROM (MM.DD)
        euDateTo: stats.euDateTo,     // 이유일 TO (MM.DD)
      },
      gradeChart,
      table: {
        days,
        rows: tableRows,
      },
      analysisChart,
      carcassChart,
    };
  }

  private transformSchedulePopup(subs: TsInsWeekSub[]) {
    const grouped: Record<string, any[]> = {};

    subs.forEach((s) => {
      const type = s.gubun.replace('SCHEDULE_', '').toLowerCase();
      if (!grouped[type]) {
        grouped[type] = [];
      }
      grouped[type].push({
        modonNo: s.str1,
        parity: s.cnt1,
        memo: s.str2,
      });
    });

    return grouped;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 차트 데이터 (기존 Mock 유지 - 추후 DB 연동)
  // ─────────────────────────────────────────────────────────────────────────────

  getChartData(chartType: mockData.ChartType) {
    const data = mockData.chartDataMap[chartType];
    if (!data) {
      return null;
    }
    return data;
  }

  getParityDistribution() {
    return mockData.parityDistribution;
  }

  getMatingByReturnDay() {
    return mockData.matingByReturnDay;
  }

  getParityReturn() {
    return mockData.parityReturn;
  }

  // getAccidentByPeriod, getParityAccident - DB 연동 완료 (SG, SG_CHART)

  getParityBirth() {
    return mockData.parityBirth;
  }

  getParityWean() {
    return mockData.parityWean;
  }

  getCullingDistribution() {
    return mockData.cullingDistribution;
  }

  getShipmentAnalysis() {
    return mockData.shipmentAnalysis;
  }

  getCarcassDistribution() {
    return mockData.carcassDistribution;
  }

  getAllWeeklyData() {
    return {
      parityDistribution: mockData.parityDistribution,
      matingByReturnDay: mockData.matingByReturnDay,
      parityReturn: mockData.parityReturn,
      // accidentByPeriod, parityAccident - DB 연동 완료 (SG, SG_CHART)
      parityBirth: mockData.parityBirth,
      parityWean: mockData.parityWean,
      cullingDistribution: mockData.cullingDistribution,
      shipmentAnalysis: mockData.shipmentAnalysis,
      carcassDistribution: mockData.carcassDistribution,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 지난주/금주/운영스냅샷 (기존 Mock 유지 - 추후 DB 연동)
  // ─────────────────────────────────────────────────────────────────────────────

  getLastweekData() {
    return mockData.lastweekData;
  }

  getLastweekSummary() {
    return mockData.lastweekData.summary;
  }

  getSowStatus() {
    return mockData.lastweekData.sowStatus;
  }

  // getAccidentType - DB 연동 완료 (SG)

  getCullingData() {
    return mockData.lastweekData.culling;
  }

  getShipmentData() {
    return mockData.lastweekData.shipment;
  }

  getThisweekData() {
    return mockData.thisweekData;
  }

  getOperationSummary() {
    return mockData.operationSummaryData;
  }

  getPsyData() {
    return mockData.operationSummaryData.psy;
  }

  getPsyTrend() {
    return mockData.operationSummaryData.psyTrend;
  }

  getAuctionPrice() {
    return mockData.operationSummaryData.auctionPrice;
  }

  /**
   * 경락가격 통계 조회 (평균/최고/최저) - 실시간
   * @param dtFrom - 시작일 (YY.MM.DD 형식)
   * @param dtTo - 종료일 (YY.MM.DD 형식)
   */
  async getAuctionPriceStats(dtFrom: string, dtTo: string) {
    try {
      const results = await this.dataSource.query(
        COM_SQL.getAuctionPriceStats,
        params({ dtFrom, dtTo }),
      );

      if (!results || results.length === 0) {
        return {
          avg: 0,
          max: 0,
          min: 0,
          source: '전국(제주제외) 탕박 등외제외',
          period: `${dtFrom} ~ ${dtTo}`,
        };
      }

      const row = results[0];
      return {
        avg: Number(row.AVG_PRICE) || 0,
        max: Number(row.MAX_PRICE) || 0,
        min: Number(row.MIN_PRICE) || 0,
        source: '전국(제주제외) 탕박 등외제외',
        period: row.PERIOD || `${dtFrom} ~ ${dtTo}`,
      };
    } catch (error) {
      this.logger.error(`경락가격 통계 조회 실패: ${error.message}`);
      return {
        avg: 0,
        max: 0,
        min: 0,
        source: '전국(제주제외) 탕박 등외제외',
        period: `${dtFrom} ~ ${dtTo}`,
      };
    }
  }

  /**
   * 경락가격 등급별 일별 조회 (팝업 차트용) - 실시간
   * @param dtFrom - 시작일 (YY.MM.DD 형식)
   * @param dtTo - 종료일 (YY.MM.DD 형식)
   * @returns AuctionPopupData 형식 (xData, grade1Plus, grade1, grade2, gradeOut, excludeOut, average)
   */
  async getAuctionPopupData(dtFrom: string, dtTo: string) {
    try {
      const results = await this.dataSource.query(
        COM_SQL.getAuctionPriceByGrade,
        params({ dtFrom, dtTo }),
      );

      // 날짜별 그룹화
      const dateMap = new Map<
        string,
        { display: string; grades: Record<string, number> }
      >();

      for (const row of results) {
        const dt = row.START_DT;
        if (!dateMap.has(dt)) {
          dateMap.set(dt, { display: row.DT_DISPLAY, grades: {} });
        }
        dateMap.get(dt)!.grades[row.GRADE_CD] = Number(row.PRICE) || 0;
      }

      // 날짜순 정렬
      const sortedDates = Array.from(dateMap.keys()).sort();

      const xData: string[] = [];
      const grade1Plus: number[] = [];
      const grade1: number[] = [];
      const grade2: number[] = [];
      const gradeOut: number[] = [];
      const excludeOut: number[] = [];
      const average: number[] = [];

      for (const dt of sortedDates) {
        const entry = dateMap.get(dt)!;
        xData.push(entry.display);
        grade1Plus.push(entry.grades['029068'] || 0);
        grade1.push(entry.grades['029069'] || 0);
        grade2.push(entry.grades['029070'] || 0);
        gradeOut.push(entry.grades['029076'] || 0);
        excludeOut.push(entry.grades['ST'] || 0);
        average.push(entry.grades['T'] || 0);
      }

      return {
        xData,
        grade1Plus,
        grade1,
        grade2,
        gradeOut,
        excludeOut,
        average,
      };
    } catch (error) {
      this.logger.error(`경락가격 등급별 조회 실패: ${error.message}`);
      return {
        xData: [],
        grade1Plus: [],
        grade1: [],
        grade2: [],
        gradeOut: [],
        excludeOut: [],
        average: [],
      };
    }
  }

  getWeather() {
    return mockData.operationSummaryData.weather;
  }

  /**
   * 농장 격자 좌표 및 지역명 조회
   * @param farmNo - 농장번호
   */
  async getFarmWeatherGrid(farmNo: number) {
    try {
      const results = await this.dataSource.query(
        WEEKLY_SQL.getFarmWeatherGrid,
        params({ farmNo }),
      );
      if (!results || results.length === 0) {
        return null;
      }
      const row = results[0];
      return {
        farmNo: row.FARM_NO,
        nx: Number(row.NX),
        ny: Number(row.NY),
        region: row.REGION || '',
      };
    } catch (error) {
      this.logger.error(`농장 격자 좌표 조회 실패: ${error.message}`);
      return null;
    }
  }

  /**
   * 오늘 날씨 조회 (extra.weather 카드용)
   * @param farmNo - 농장번호
   */
  async getWeatherToday(farmNo: number) {
    try {
      const grid = await this.getFarmWeatherGrid(farmNo);
      if (!grid) {
        return null;
      }

      // 일별 날씨 (최고/최저)
      const dailyResults = await this.dataSource.query(
        WEEKLY_SQL.getWeatherToday,
        params({ nx: grid.nx, ny: grid.ny }),
      );

      // 현재 시간 날씨 (현재 기온)
      const currentResults = await this.dataSource.query(
        WEEKLY_SQL.getWeatherCurrent,
        params({ nx: grid.nx, ny: grid.ny }),
      );

      const region = this.extractRegionName(grid.region);

      if (!dailyResults || dailyResults.length === 0) {
        // 일별 데이터 없으면 현재 시간 데이터로 대체
        if (currentResults && currentResults.length > 0) {
          const curr = currentResults[0];
          const currTemp = curr.TEMP !== null ? Number(curr.TEMP) : null;
          return {
            min: currTemp,
            max: currTemp,
            current: currTemp,
            region,
            weatherCd: curr.WEATHER_CD,
            weatherNm: curr.WEATHER_NM,
            skyCd: curr.SKY_CD,
          };
        }
        return {
          min: null,
          max: null,
          current: null,
          region,
        };
      }

      const row = dailyResults[0];
      // TEMP_HIGH/TEMP_LOW가 NULL이면 TEMP_AVG를 fallback으로 사용
      const tempAvg = row.TEMP_AVG !== null ? Number(row.TEMP_AVG) : null;

      // 현재 기온 (시간별 데이터에서)
      let currentTemp = tempAvg;
      let currentWeatherCd = row.WEATHER_CD;
      let currentWeatherNm = row.WEATHER_NM;
      let currentSkyCd = row.SKY_CD;

      if (currentResults && currentResults.length > 0) {
        const curr = currentResults[0];
        currentTemp = curr.TEMP !== null ? Number(curr.TEMP) : tempAvg;
        currentWeatherCd = curr.WEATHER_CD || row.WEATHER_CD;
        currentWeatherNm = curr.WEATHER_NM || row.WEATHER_NM;
        currentSkyCd = curr.SKY_CD || row.SKY_CD;
      }

      return {
        min: row.TEMP_LOW !== null ? Number(row.TEMP_LOW) : tempAvg,
        max: row.TEMP_HIGH !== null ? Number(row.TEMP_HIGH) : tempAvg,
        current: currentTemp,
        region,
        weatherCd: currentWeatherCd,
        weatherNm: currentWeatherNm,
        skyCd: currentSkyCd,
      };
    } catch (error) {
      this.logger.error(`오늘 날씨 조회 실패: ${error.message}`);
      return null;
    }
  }

  /**
   * 주간 일별 날씨 조회 (날씨 팝업용)
   * @param farmNo - 농장번호
   * @param dtFrom - 시작일 (YYYYMMDD)
   * @param dtTo - 종료일 (YYYYMMDD)
   */
  async getWeatherDaily(farmNo: number, dtFrom: string, dtTo: string) {
    try {
      const grid = await this.getFarmWeatherGrid(farmNo);
      if (!grid) {
        return { region: '', daily: [] };
      }

      const results = await this.dataSource.query(
        WEEKLY_SQL.getWeatherDaily,
        params({ nx: grid.nx, ny: grid.ny, dtFrom, dtTo }),
      );

      const daily = (results || []).map((row: any) => ({
        wkDate: row.WK_DATE,
        weatherCd: row.WEATHER_CD,
        weatherNm: row.WEATHER_NM,
        tempAvg: row.TEMP_AVG !== null ? Number(row.TEMP_AVG) : null,
        tempHigh: row.TEMP_HIGH !== null ? Number(row.TEMP_HIGH) : null,
        tempLow: row.TEMP_LOW !== null ? Number(row.TEMP_LOW) : null,
        rainProb: row.RAIN_PROB !== null ? Number(row.RAIN_PROB) : null,
        rainAmt: row.RAIN_AMT !== null ? Number(row.RAIN_AMT) : null,
        humidity: row.HUMIDITY !== null ? Number(row.HUMIDITY) : null,
        windSpeed: row.WIND_SPEED !== null ? Number(row.WIND_SPEED) : null,
        skyCd: row.SKY_CD,
        isForecast: row.IS_FORECAST,
      }));

      return {
        region: this.extractRegionName(grid.region),
        nx: grid.nx,
        ny: grid.ny,
        daily,
      };
    } catch (error) {
      this.logger.error(`주간 날씨 조회 실패: ${error.message}`);
      return { region: '', daily: [] };
    }
  }

  /**
   * 시간별 날씨 조회 (날짜 클릭 시)
   * @param farmNo - 농장번호
   * @param wkDate - 조회일 (YYYYMMDD)
   */
  async getWeatherHourly(farmNo: number, wkDate: string) {
    try {
      const grid = await this.getFarmWeatherGrid(farmNo);
      if (!grid) {
        return { region: '', hourly: [] };
      }

      const results = await this.dataSource.query(
        WEEKLY_SQL.getWeatherHourly,
        params({ nx: grid.nx, ny: grid.ny, wkDate }),
      );

      const hourly = (results || []).map((row: any) => ({
        wkDate: row.WK_DATE,
        wkTime: row.WK_TIME,
        weatherCd: row.WEATHER_CD,
        weatherNm: row.WEATHER_NM,
        temp: row.TEMP !== null ? Number(row.TEMP) : null,
        rainProb: row.RAIN_PROB !== null ? Number(row.RAIN_PROB) : null,
        rainAmt: row.RAIN_AMT !== null ? Number(row.RAIN_AMT) : null,
        humidity: row.HUMIDITY !== null ? Number(row.HUMIDITY) : null,
        windSpeed: row.WIND_SPEED !== null ? Number(row.WIND_SPEED) : null,
        skyCd: row.SKY_CD,
        ptyCd: row.PTY_CD,
      }));

      return {
        region: this.extractRegionName(grid.region),
        wkDate,
        hourly,
      };
    } catch (error) {
      this.logger.error(`시간별 날씨 조회 실패: ${error.message}`);
      return { region: '', hourly: [] };
    }
  }

  /**
   * 주소에서 지역명 추출 (시도 시군구 읍면동)
   * @param addr - 전체 주소 (예: 충청남도 홍성군 홍동면 문당리 ...)
   */
  private extractRegionName(addr: string): string {
    if (!addr) return '';
    // 공백으로 분리하여 앞 3개만 (시도 시군구 읍면동)
    const parts = addr.split(/\s+/);
    return parts.slice(0, 3).join(' ');
  }

  getInsights() {
    return mockData.operationSummaryData.insights;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TS_PRODUCTIVITY 조회 (주간/월간/분기 공통)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * 생산성 데이터 조회 (TS_PRODUCTIVITY)
   * @param farmNo - 농장번호
   * @param statYear - 통계년도 (YYYY)
   * @param period - 기간구분 (W:주간, M:월간, Q:분기)
   * @param periodNo - 기간차수 (W:1~53, M:1~12, Q:1~4)
   * @param pcode - PCODE (optional, 031~035)
   */
  async getProductivity(
    farmNo: number,
    statYear: number,
    period: string,
    periodNo: number,
    pcode?: string,
  ) {
    try {
      const results = await this.dataSource.query(
        WEEKLY_SQL.getProductivity,
        params({ farmNo, statYear, period, periodNo, pcode: pcode || null }),
      );

      if (!results || results.length === 0) {
        return null;
      }

      // PCODE별로 그룹화
      const grouped: Record<string, any> = {};
      for (const row of results) {
        const code = row.PCODE;
        grouped[code] = this.mapProductivityRow(row);
      }

      return grouped;
    } catch (error) {
      this.logger.error(`생산성 데이터 조회 실패: ${error.message}`);
      return null;
    }
  }

  // getProductivitySangsi 제거됨 (방식 2 적용)
  // - 상시모돈 데이터는 ETL에서 TS_PRODUCTIVITY → TS_INS_WEEK.MODON_SANGSI_CNT로 업데이트
  // - 웹에서는 TS_INS_WEEK.MODON_SANGSI_CNT에서 직접 읽어옴

  /**
   * TS_PRODUCTIVITY row를 객체로 변환
   */
  private mapProductivityRow(row: any) {
    const result: Record<string, number | string | null> = {
      farmNo: row.FARM_NO,
      pcode: row.PCODE,
      statYear: row.STAT_YEAR,
      period: row.PERIOD,
      periodNo: row.PERIOD_NO,
      statDate: row.STAT_DATE,
    };

    // C001 ~ C043 매핑
    for (let i = 1; i <= 43; i++) {
      const col = `C${String(i).padStart(3, '0')}`;
      result[col] = row[col] !== undefined ? Number(row[col]) : null;
    }

    return result;
  }
}

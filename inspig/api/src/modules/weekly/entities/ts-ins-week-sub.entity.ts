import { Entity, Column, PrimaryColumn, ManyToOne, JoinColumn } from 'typeorm';
import { TsInsWeek } from './ts-ins-week.entity';

/**
 * TS_INS_WEEK_SUB: 리포트 상세 테이블 (팝업 데이터)
 *
 * GUBUN/SUB_GUBUN별 데이터 용도:
 *
 * CONFIG (1행/농장)
 *   - SUB_GUBUN='-': 농장 설정값 (VAL_1~VAL_15)
 *
 * ALERT (4행/농장) - 지연기간별 집계 (개별 모돈 데이터 없음)
 *   - SUB_GUBUN='-', SORT_NO 1~4: 지연기간별 관리대상 집계 (~3일/4~7일/8~14일/14일~)
 *     CNT_1~CNT_5: HUBO/EU_MI/SG_MI/BM_DELAY/EU_DELAY
 *
 * GB (2행/농장) - 교배
 *   - SUB_GUBUN='STAT': 교배 요약 통계
 *   - SUB_GUBUN='CHART': 재귀일별 교배복수 차트
 *
 * BM (1행/농장) - 분만
 *   - SUB_GUBUN='-': 분만 요약 통계
 *
 * EU (1행/농장) - 이유
 *   - SUB_GUBUN='-': 이유 요약 통계
 *
 * SG (3행/농장) - 임신사고
 *   - SUB_GUBUN='STAT', SORT_NO 1: 사고현황 요약
 *   - SUB_GUBUN='STAT', SORT_NO 2: 산차별 사고원인
 *   - SUB_GUBUN='CHART': 임신일별 사고복수 차트
 *
 * DOPE (4+N행/농장) - 도태/폐사
 *   - SUB_GUBUN='STAT', SORT_NO 1: 상태별 집계 (도태/폐사/전출/판매)
 *   - SUB_GUBUN='STAT', SORT_NO 2: 도태원인별 집계
 *   - SUB_GUBUN='LIST': 개별 도폐사 기록 (N행)
 *   - SUB_GUBUN='CHART': 상태분포 차트
 *
 * SHIP (17+N행/농장) - 출하
 *   - SUB_GUBUN='STAT': 출하 통계 (2행)
 *   - SUB_GUBUN='CARCASS': 개별 도체 성적 (N행)
 *   - SUB_GUBUN='ROW': 출하분석 상세 (13행)
 *   - SUB_GUBUN='SCATTER': 산점도 데이터 (1행, JSON_DATA CLOB)
 *
 * SCHEDULE (3+N행/농장) - 금주예정
 *   - SUB_GUBUN='-': 예정 요약 카운트
 *   - SUB_GUBUN='CAL': 캘린더 그리드 (요일별)
 *   - SUB_GUBUN='GB/BM/EU/IMSIN': 예정 팝업 상세 (모돈작업설정 시)
 *   - SUB_GUBUN='VACCINE': 백신예정 팝업
 *   - SUB_GUBUN='METHOD': 산정방식 정보
 *   - SUB_GUBUN='HELP': 도움말 정보
 */
@Entity({ name: 'TS_INS_WEEK_SUB' })
export class TsInsWeekSub {
  @PrimaryColumn({ name: 'MASTER_SEQ', type: 'number' })
  masterSeq: number;

  @PrimaryColumn({ name: 'FARM_NO', type: 'number' })
  farmNo: number;

  @PrimaryColumn({ name: 'GUBUN', type: 'varchar2', length: 20 })
  gubun: string;

  @PrimaryColumn({ name: 'SUB_GUBUN', type: 'varchar2', length: 20, default: '-' })
  subGubun: string;

  @PrimaryColumn({ name: 'SORT_NO', type: 'number' })
  sortNo: number;

  // 공통 코드 컬럼
  @Column({ name: 'CODE_1', type: 'varchar2', length: 30, nullable: true })
  code1: string;

  @Column({ name: 'CODE_2', type: 'varchar2', length: 30, nullable: true })
  code2: string;

  // 숫자형 데이터 (CNT_1 ~ CNT_15) - 소숫점 1자리까지 지원 (평균값 등)
  @Column({ name: 'CNT_1', type: 'number', precision: 10, scale: 2, default: 0 })
  cnt1: number;

  @Column({ name: 'CNT_2', type: 'number', precision: 10, scale: 2, default: 0 })
  cnt2: number;

  @Column({ name: 'CNT_3', type: 'number', precision: 10, scale: 2, default: 0 })
  cnt3: number;

  @Column({ name: 'CNT_4', type: 'number', precision: 10, scale: 2, default: 0 })
  cnt4: number;

  @Column({ name: 'CNT_5', type: 'number', precision: 10, scale: 2, default: 0 })
  cnt5: number;

  @Column({ name: 'CNT_6', type: 'number', precision: 10, scale: 2, default: 0 })
  cnt6: number;

  @Column({ name: 'CNT_7', type: 'number', precision: 10, scale: 2, default: 0 })
  cnt7: number;

  @Column({ name: 'CNT_8', type: 'number', precision: 10, scale: 2, default: 0 })
  cnt8: number;

  @Column({ name: 'CNT_9', type: 'number', precision: 10, scale: 2, default: 0 })
  cnt9: number;

  @Column({ name: 'CNT_10', type: 'number', precision: 10, scale: 2, default: 0 })
  cnt10: number;

  @Column({ name: 'CNT_11', type: 'number', precision: 10, scale: 2, default: 0 })
  cnt11: number;

  @Column({ name: 'CNT_12', type: 'number', precision: 10, scale: 2, default: 0 })
  cnt12: number;

  @Column({ name: 'CNT_13', type: 'number', precision: 10, scale: 2, default: 0 })
  cnt13: number;

  @Column({ name: 'CNT_14', type: 'number', precision: 10, scale: 2, default: 0 })
  cnt14: number;

  @Column({ name: 'CNT_15', type: 'number', precision: 10, scale: 2, default: 0 })
  cnt15: number;

  // 수치형 데이터 (VAL_1 ~ VAL_15)
  @Column({ name: 'VAL_1', type: 'number', precision: 10, scale: 2, default: 0 })
  val1: number;

  @Column({ name: 'VAL_2', type: 'number', precision: 10, scale: 2, default: 0 })
  val2: number;

  @Column({ name: 'VAL_3', type: 'number', precision: 10, scale: 2, default: 0 })
  val3: number;

  @Column({ name: 'VAL_4', type: 'number', precision: 10, scale: 2, default: 0 })
  val4: number;

  @Column({ name: 'VAL_5', type: 'number', precision: 10, scale: 2, default: 0 })
  val5: number;

  @Column({ name: 'VAL_6', type: 'number', precision: 10, scale: 2, default: 0 })
  val6: number;

  @Column({ name: 'VAL_7', type: 'number', precision: 10, scale: 2, default: 0 })
  val7: number;

  @Column({ name: 'VAL_8', type: 'number', precision: 10, scale: 2, default: 0 })
  val8: number;

  @Column({ name: 'VAL_9', type: 'number', precision: 10, scale: 2, default: 0 })
  val9: number;

  @Column({ name: 'VAL_10', type: 'number', precision: 10, scale: 2, default: 0 })
  val10: number;

  @Column({ name: 'VAL_11', type: 'number', precision: 10, scale: 2, default: 0 })
  val11: number;

  @Column({ name: 'VAL_12', type: 'number', precision: 10, scale: 2, default: 0 })
  val12: number;

  @Column({ name: 'VAL_13', type: 'number', precision: 10, scale: 2, default: 0 })
  val13: number;

  @Column({ name: 'VAL_14', type: 'number', precision: 10, scale: 2, default: 0 })
  val14: number;

  @Column({ name: 'VAL_15', type: 'number', precision: 10, scale: 2, default: 0 })
  val15: number;

  // 문자형 데이터 (STR_1 ~ STR_15)
  @Column({ name: 'STR_1', type: 'varchar2', length: 100, nullable: true })
  str1: string;

  @Column({ name: 'STR_2', type: 'varchar2', length: 100, nullable: true })
  str2: string;

  @Column({ name: 'STR_3', type: 'varchar2', length: 100, nullable: true })
  str3: string;

  @Column({ name: 'STR_4', type: 'varchar2', length: 100, nullable: true })
  str4: string;

  @Column({ name: 'STR_5', type: 'varchar2', length: 100, nullable: true })
  str5: string;

  @Column({ name: 'STR_6', type: 'varchar2', length: 100, nullable: true })
  str6: string;

  @Column({ name: 'STR_7', type: 'varchar2', length: 100, nullable: true })
  str7: string;

  @Column({ name: 'STR_8', type: 'varchar2', length: 100, nullable: true })
  str8: string;

  @Column({ name: 'STR_9', type: 'varchar2', length: 100, nullable: true })
  str9: string;

  @Column({ name: 'STR_10', type: 'varchar2', length: 100, nullable: true })
  str10: string;

  @Column({ name: 'STR_11', type: 'varchar2', length: 100, nullable: true })
  str11: string;

  @Column({ name: 'STR_12', type: 'varchar2', length: 100, nullable: true })
  str12: string;

  @Column({ name: 'STR_13', type: 'varchar2', length: 100, nullable: true })
  str13: string;

  @Column({ name: 'STR_14', type: 'varchar2', length: 100, nullable: true })
  str14: string;

  @Column({ name: 'STR_15', type: 'varchar2', length: 100, nullable: true })
  str15: string;

  // 힌트 컬럼 (HINT1, HINT2, HINT3) - 예정 산출기준 설명용
  @Column({ name: 'HINT1', type: 'varchar2', length: 500, nullable: true })
  hint1: string;

  @Column({ name: 'HINT2', type: 'varchar2', length: 500, nullable: true })
  hint2: string;

  @Column({ name: 'HINT3', type: 'varchar2', length: 500, nullable: true })
  hint3: string;

  // JSON 데이터 컬럼 (CLOB) - 산점도 등 대용량 JSON 저장용
  @Column({ name: 'JSON_DATA', type: 'clob', nullable: true })
  jsonData: string;

  @Column({ name: 'LOG_INS_DT', type: 'date', default: () => 'SYSDATE' })
  logInsDt: Date;

  // Relations
  @ManyToOne(() => TsInsWeek, (week) => week.subs)
  @JoinColumn([
    { name: 'MASTER_SEQ', referencedColumnName: 'masterSeq' },
    { name: 'FARM_NO', referencedColumnName: 'farmNo' },
  ])
  week: TsInsWeek;
}

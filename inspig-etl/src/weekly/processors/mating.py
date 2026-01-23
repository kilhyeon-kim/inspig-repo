"""
교배 팝업 데이터 추출 프로세서
SP_INS_WEEK_GB_POPUP 프로시저 Python 전환

역할:
- 교배 요약 통계 (GUBUN='GB', SUB_GUBUN='STAT')
- 재귀일별 교배복수 차트 (GUBUN='GB', SUB_GUBUN='CHART')

TS_INS_CONF 설정 지원:
- method='farm': 농장 기본값 사용 (TC_FARM_CONFIG)
- method='modon': 모돈 작업설정 사용 (FN_MD_SCHEDULE_BSE_2020)
"""
import json
import logging
from datetime import datetime, timedelta
from typing import Any, Dict, Optional

from .base import BaseProcessor

logger = logging.getLogger(__name__)


class MatingProcessor(BaseProcessor):
    """교배 팝업 프로세서"""

    PROC_NAME = 'MatingProcessor'

    def process(self, dt_from: str, dt_to: str, **kwargs) -> Dict[str, Any]:
        """교배 데이터 추출

        Args:
            dt_from: 시작일 (YYYYMMDD)
            dt_to: 종료일 (YYYYMMDD)

        Returns:
            처리 결과 딕셔너리
        """
        self.logger.info(f"교배 팝업 시작: 농장={self.farm_no}, 기간={dt_from}~{dt_to}")

        # 날짜 포맷 변환 (YYYYMMDD → yyyy-MM-dd)
        sdt = f"{dt_from[:4]}-{dt_from[4:6]}-{dt_from[6:8]}"
        edt = f"{dt_to[:4]}-{dt_to[4:6]}-{dt_to[6:8]}"

        # 날짜 객체 변환
        dt_from_obj = datetime.strptime(dt_from, '%Y%m%d')
        dt_to_obj = datetime.strptime(dt_to, '%Y%m%d')

        # 1. 기존 데이터 삭제
        self._delete_existing()

        # 2. TS_INS_CONF 설정 조회 (금주 작업예정 산정방식)
        ins_conf = self._get_ins_conf()

        # 3. 예정 복수 조회 (설정에 따라 분기)
        plan_hubo, plan_js, prev_hint = self._get_plan_counts(sdt, edt, dt_from_obj, dt_to_obj, ins_conf)

        # 4. 연간 누적 교배복수 조회
        acc_gb_cnt = self._get_acc_count(dt_to)

        # 5. 교배 요약 통계 집계 및 INSERT
        stats = self._insert_stats(dt_from, dt_to, plan_hubo, plan_js, acc_gb_cnt)

        # 6. 재귀일별 교배복수 차트 INSERT
        chart_cnt = self._insert_chart(dt_from, dt_to)

        # 7. 힌트 메시지 INSERT (산출 기준 설명)
        # prev_hint가 있으면 이전 주차 힌트 사용, 없으면 현재 설정으로 생성
        self._insert_hint(ins_conf, prev_hint)

        # 8. TS_INS_WEEK 업데이트
        self._update_week(stats['total_cnt'], acc_gb_cnt)

        self.logger.info(f"교배 팝업 완료: 농장={self.farm_no}, 합계={stats['total_cnt']}")

        return {
            'status': 'success',
            'total_cnt': stats['total_cnt'],
            'chart_cnt': chart_cnt,
        }

    def _delete_existing(self) -> None:
        """기존 GB 데이터 삭제"""
        sql = """
        DELETE FROM TS_INS_WEEK_SUB
        WHERE MASTER_SEQ = :master_seq AND FARM_NO = :farm_no AND GUBUN = 'GB'
        """
        self.execute(sql, {'master_seq': self.master_seq, 'farm_no': self.farm_no})

    def _get_ins_conf(self) -> Dict[str, Any]:
        """TS_INS_CONF에서 교배예정 산정방식 설정 조회

        Returns:
            {'method': 'farm'|'modon', 'tasks': [], 'seq_filter': ''}
            TS_INS_CONF 설정이 없으면 modon 전체 방식으로 처리 (pig3.1 기준)
        """
        # 기본값: pig3.1 구독 신청 시 기본값과 동일 (modon + 전체 선택)
        default_conf = {'method': 'modon', 'tasks': None, 'seq_filter': '-1'}

        sql = """
        SELECT WEEK_TW_GY
        FROM TS_INS_CONF
        WHERE FARM_NO = :farm_no
        """
        result = self.fetch_one(sql, {'farm_no': self.farm_no})

        if not result or not result[0]:
            self.logger.info(f"TS_INS_CONF 교배 설정 없음, modon 전체 사용: farm_no={self.farm_no}")
            return default_conf

        try:
            parsed = json.loads(result[0])
            method = parsed.get('method', 'modon')
            tasks = parsed.get('tasks') if 'tasks' in parsed else None

            if method == 'modon':
                if tasks is None or len(tasks) == 0:
                    seq_filter = ''  # 빈 배열이면 작업 없음
                else:
                    seq_filter = ','.join(str(t) for t in tasks)
            else:
                seq_filter = '-1'

            conf = {'method': method, 'tasks': tasks, 'seq_filter': seq_filter}
            self.logger.info(f"TS_INS_CONF 교배 설정 로드: farm_no={self.farm_no}, conf={conf}")
            return conf
        except json.JSONDecodeError:
            self.logger.warning(f"JSON 파싱 실패: WEEK_TW_GY={result[0]}")
            return default_conf

    def _get_farm_config(self) -> Dict[str, int]:
        """TC_FARM_CONFIG에서 교배예정 계산에 필요한 설정값 조회

        Returns:
            {
                'avg_return_day': 평균재귀일 (140008, 기본 7일),
                'first_mating_age': 초교배일령 (140007, 기본 240일)
            }
        """
        sql = """
        SELECT CODE, TO_NUMBER(NVL(CVALUE, DECODE(CODE, '140007', '240', '140008', '7')))
        FROM TC_FARM_CONFIG
        WHERE FARM_NO = :farm_no AND CODE IN ('140007', '140008')
        """
        cursor = self.conn.cursor()
        try:
            cursor.execute(sql, {'farm_no': self.farm_no})
            rows = cursor.fetchall()

            config = {
                'avg_return_day': 7,
                'first_mating_age': 240,
            }

            code_map = {
                '140007': 'first_mating_age',
                '140008': 'avg_return_day',
            }
            for code, value in rows:
                if code in code_map:
                    config[code_map[code]] = int(value) if value else config[code_map[code]]

            self.logger.info(f"TC_FARM_CONFIG 교배 설정 조회: farm_no={self.farm_no}, config={config}")
            return config
        finally:
            cursor.close()

    def _get_plan_from_prev_week(self) -> Optional[tuple]:
        """이전 주차 금주예정에서 교배 예정 조회 (초교배/정상교배 분리 + 힌트)

        조회 우선순위:
        1. SCHEDULE/GB 상세 데이터 (method='modon'일 때 저장됨) → 초교배/정상교배 분리
        2. TS_INS_WEEK.THIS_GB_SUM (method='farm'일 때도 저장됨) → 전체 합계만

        Returns:
            (plan_hubo, plan_js, hint) 또는 None (이전 주차 데이터 없음)
        """
        # 이전 주차의 MASTER_SEQ 조회 (base.py 헬퍼 사용)
        prev_master_seq = self._get_prev_week_master_seq()
        if not prev_master_seq:
            return None

        # 1. 힌트 정보 조회 (SUB_GUBUN='HELP', STR_1=교배예정 힌트)
        sql_hint = """
        SELECT STR_1
        FROM TS_INS_WEEK_SUB
        WHERE MASTER_SEQ = :prev_master_seq
          AND FARM_NO = :farm_no
          AND GUBUN = 'SCHEDULE'
          AND SUB_GUBUN = 'HELP'
        """
        hint_result = self.fetch_one(sql_hint, {
            'prev_master_seq': prev_master_seq,
            'farm_no': self.farm_no,
        })
        hint = hint_result[0] if hint_result else None

        # 2. SCHEDULE/- 요약 데이터에서 교배 합계 조회
        # CNT_1 = gb_sum (교배예정 합계)
        sql_summary = """
        SELECT CNT_1
        FROM TS_INS_WEEK_SUB
        WHERE MASTER_SEQ = :prev_master_seq
          AND FARM_NO = :farm_no
          AND GUBUN = 'SCHEDULE'
          AND SUB_GUBUN = '-'
        """
        summary_result = self.fetch_one(sql_summary, {
            'prev_master_seq': prev_master_seq,
            'farm_no': self.farm_no,
        })

        if summary_result and summary_result[0] is not None:
            total_gb = summary_result[0] or 0

            # 3. SCHEDULE/GB 상세에서 초교배/정상교배 비율 분리 시도
            # STR_3 = MODON_STATUS_CD (010001: 후보돈, 010005: 이유돈, 010006: 사고돈)
            sql_detail = """
            SELECT
                NVL(SUM(CASE WHEN STR_3 = '010001' THEN CNT_1 ELSE 0 END), 0) AS HUBO_SUM,
                NVL(SUM(CASE WHEN STR_3 != '010001' THEN CNT_1 ELSE 0 END), 0) AS JS_SUM,
                COUNT(*) AS ROW_CNT
            FROM TS_INS_WEEK_SUB
            WHERE MASTER_SEQ = :prev_master_seq
              AND FARM_NO = :farm_no
              AND GUBUN = 'SCHEDULE'
              AND SUB_GUBUN = 'GB'
            """
            detail_result = self.fetch_one(sql_detail, {
                'prev_master_seq': prev_master_seq,
                'farm_no': self.farm_no,
            })

            # 상세 데이터가 있으면 초교배/정상교배 분리
            if detail_result and detail_result[2] > 0:
                plan_hubo = detail_result[0] or 0
                plan_js = detail_result[1] or 0
                self.logger.info(f"이전 주차 금주예정 조회: 교배합계={total_gb}, 초교배={plan_hubo}, 정상교배={plan_js}")
                return (plan_hubo, plan_js, hint)

            # 상세 없으면 전체를 정상교배로 처리
            self.logger.info(f"이전 주차 금주예정 조회: 교배합계={total_gb} (정상교배로 처리)")
            return (0, total_gb, hint)

        return None

    def _get_plan_counts(self, sdt: str, edt: str, dt_from: datetime, dt_to: datetime,
                         ins_conf: Dict[str, Any]) -> tuple:
        """예정 복수 조회 (이전 주차 우선 조회)

        1차: 이전 주차 금주예정 조회
        2차: 이전 주차 없으면 직접 계산 (Fallback)

        Args:
            sdt: 시작일 (yyyy-MM-dd)
            edt: 종료일 (yyyy-MM-dd)
            dt_from: 시작일 (datetime)
            dt_to: 종료일 (datetime)
            ins_conf: TS_INS_CONF 설정

        Returns:
            (초교배예정, 정상교배예정, 힌트) 튜플
        """
        # 1. 이전 주차 금주예정 조회 시도
        prev_data = self._get_plan_from_prev_week()
        if prev_data is not None:
            year, week_no = self._get_current_week_info()
            self.logger.info(f"이전 주차 금주예정 사용: year={year}, week={week_no}")
            return prev_data  # (plan_hubo, plan_js, hint) 반환

        # 2. Fallback: 이전 주차 없으면 직접 계산
        self.logger.info("직접 계산 (Fallback): 이전 주차 데이터 없음")
        return self._calculate_plan_counts(sdt, edt, dt_from, dt_to, ins_conf)

    def _calculate_plan_counts(self, sdt: str, edt: str, dt_from: datetime, dt_to: datetime,
                               ins_conf: Dict[str, Any]) -> tuple:
        """예정 복수 직접 계산 (기존 로직)

        Args:
            sdt: 시작일 (yyyy-MM-dd)
            edt: 종료일 (yyyy-MM-dd)
            dt_from: 시작일 (datetime)
            dt_to: 종료일 (datetime)
            ins_conf: TS_INS_CONF 설정

        Returns:
            (초교배예정, 정상교배예정, None) 튜플 - 힌트는 _insert_hint()에서 생성
        """
        if ins_conf['method'] == 'farm':
            plan_hubo, plan_js = self._count_plan_by_farm(dt_from, dt_to)
            return plan_hubo, plan_js, None
        else:
            plan_hubo, plan_js = self._count_plan_by_modon(sdt, edt, ins_conf['seq_filter'])
            return plan_hubo, plan_js, None

    def _count_plan_by_modon(self, sdt: str, edt: str, seq_filter: str) -> tuple:
        """모돈 작업설정 기준 예정 복수 조회 (FN_MD_SCHEDULE_BSE_2020)"""
        if seq_filter == '':
            self.logger.info("교배 작업 없음 (seq_filter=''), 카운트 생략")
            return 0, 0

        # 초교배 예정 (후보돈: 010001)
        sql_hubo = """
        SELECT COUNT(*)
        FROM TABLE(FN_MD_SCHEDULE_BSE_2020(
            :farm_no, 'JOB-DAJANG', '150005', '010001',
            :sdt, :edt, NULL, 'ko', 'yyyy-MM-dd', :seq_filter, NULL
        ))
        """
        result = self.fetch_one(sql_hubo, {'farm_no': self.farm_no, 'sdt': sdt, 'edt': edt, 'seq_filter': seq_filter})
        plan_hubo = result[0] if result else 0

        # 정상교배 예정 (이유돈: 010005)
        sql_js = """
        SELECT COUNT(*)
        FROM TABLE(FN_MD_SCHEDULE_BSE_2020(
            :farm_no, 'JOB-DAJANG', '150005', '010005',
            :sdt, :edt, NULL, 'ko', 'yyyy-MM-dd', :seq_filter, NULL
        ))
        """
        result = self.fetch_one(sql_js, {'farm_no': self.farm_no, 'sdt': sdt, 'edt': edt, 'seq_filter': seq_filter})
        plan_js = result[0] if result else 0

        return plan_hubo, plan_js

    def _count_plan_by_farm(self, dt_from: datetime, dt_to: datetime) -> tuple:
        """농장 기본값 기준 예정 복수 조회

        TC_FARM_CONFIG 설정값을 사용하여 예정일 계산:
        - 초교배: 생년월일 + 초교배일령 (기본 240일)
        - 정상교배: 이유일 + 평균재귀일 (기본 7일)
        """
        farm_config = self._get_farm_config()

        # 초교배 예정 (후보돈: 생년월일 + 초교배일령)
        sql_hubo = """
        SELECT COUNT(*)
        FROM TB_MODON MD
        WHERE MD.FARM_NO = :farm_no
          AND MD.USE_YN = 'Y'
          AND MD.OUT_DT > :dt_to
          AND MD.STATUS_CD = '010001'
          AND MD.BIRTH_DT IS NOT NULL
          AND MD.BIRTH_DT + :first_mating_age BETWEEN :dt_from AND :dt_to
        """
        result = self.fetch_one(sql_hubo, {
            'farm_no': self.farm_no,
            'dt_from': dt_from,
            'dt_to': dt_to,
            'first_mating_age': farm_config['first_mating_age'],
        })
        plan_hubo = result[0] if result else 0

        # 정상교배 예정 (이유돈: 이유일 + 평균재귀일)
        # - 마지막 작업이 이유(E)이고 대리모 아닌 경우
        # - 이유일 + 평균재귀일이 조회 기간 내인 경우
        sql_js = """
        SELECT COUNT(*)
        FROM (
            SELECT MD.PIG_NO,
                   TO_DATE(WK.WK_DT, 'YYYYMMDD') + :avg_return_day AS PASS_DT
            FROM TB_MODON MD
            INNER JOIN (
                SELECT FARM_NO, PIG_NO, WK_DT, DAERI_YN,
                       ROW_NUMBER() OVER (PARTITION BY FARM_NO, PIG_NO ORDER BY SEQ DESC) AS RN
                FROM TB_MODON_WK
                WHERE FARM_NO = :farm_no
                  AND USE_YN = 'Y'
                  AND WK_GUBUN = 'E'
            ) WK ON MD.FARM_NO = WK.FARM_NO AND MD.PIG_NO = WK.PIG_NO AND WK.RN = 1
            WHERE MD.FARM_NO = :farm_no
              AND MD.USE_YN = 'Y'
              AND MD.OUT_DT > :dt_to
              AND MD.STATUS_CD = '010005'
              AND WK.DAERI_YN = 'N'
        )
        WHERE PASS_DT BETWEEN :dt_from AND :dt_to
        """
        result = self.fetch_one(sql_js, {
            'farm_no': self.farm_no,
            'dt_from': dt_from,
            'dt_to': dt_to,
            'avg_return_day': farm_config['avg_return_day'],
        })
        plan_js = result[0] if result else 0

        self.logger.info(f"농장기본값 교배예정: 초교배={plan_hubo}, 정상교배={plan_js}")
        return plan_hubo, plan_js

    def _get_acc_count(self, dt_to: str) -> int:
        """연간 누적 교배복수 조회 (1/1 ~ 기준일)

        data_loader.gb 데이터를 필터링하여 계산
        """
        year_start = dt_to[:4] + '0101'

        if not self.data_loader:
            return 0

        data = self.data_loader.get_data()
        gb_list = data.get('gb', [])

        # 연간 교배 데이터 필터링
        filtered = [
            g for g in gb_list
            if g.get('GB_DT') and year_start <= str(g['GB_DT'])[:8] <= dt_to
        ]

        return len(filtered)

    def _insert_stats(self, dt_from: str, dt_to: str, plan_hubo: int, plan_js: int, acc_gb_cnt: int) -> Dict[str, Any]:
        """교배 요약 통계 집계 및 INSERT

        data_loader.modon_wk 데이터를 필터링하여 계산
        - PREV_*: 이전 작업 정보 (SEQ-1) - 재귀일 계산용
        - NEXT_*: 다음 작업 정보 (SEQ+1) - 사고/분만 여부 판단용
        """
        if not self.data_loader:
            stats = {'total_cnt': 0, 'sago_cnt': 0, 'bunman_cnt': 0, 'avg_return': 0,
                     'avg_first_gb': 0, 'first_gb_cnt': 0, 'sago_gb_cnt': 0, 'js_gb_cnt': 0}
        else:
            from datetime import datetime
            data = self.data_loader.get_data()
            modon_wk = data.get('modon_wk', [])
            modon_list = data.get('modon', [])

            # 모돈 생년월일 딕셔너리
            modon_birth = {str(m.get('MODON_NO', '')): m.get('BIRTH_DT') for m in modon_list}

            # 주간 교배 데이터 필터링 (WK_GUBUN = 'G')
            week_gb = [
                wk for wk in modon_wk
                if wk.get('WK_GUBUN') == 'G'
                and wk.get('WK_DT') and dt_from <= str(wk['WK_DT'])[:8] <= dt_to
            ]

            total_cnt = len(week_gb)

            # 다음 작업이 사고(F)인 건수
            sago_cnt = sum(1 for wk in week_gb if wk.get('NEXT_WK_GUBUN') == 'F')

            # 다음 작업이 분만(B)인 건수
            bunman_cnt = sum(1 for wk in week_gb if wk.get('NEXT_WK_GUBUN') == 'B')

            # 재귀일 계산 (정상교배만: GYOBAE_CNT=1, 초교배 제외: NOT(SANCHA=0 AND GYOBAE_CNT=1))
            return_days = []
            for wk in week_gb:
                gyobae_cnt = wk.get('GYOBAE_CNT') or 0
                sancha = wk.get('SANCHA') or 0
                prev_wk_dt = wk.get('PREV_WK_DT')
                wk_dt = wk.get('WK_DT')

                # 정상교배 (GYOBAE_CNT=1) AND 이전 작업일 있음 AND 초교배 아님
                if gyobae_cnt == 1 and prev_wk_dt and not (sancha == 0 and gyobae_cnt == 1):
                    try:
                        cur_dt = datetime.strptime(str(wk_dt)[:8], '%Y%m%d')
                        prv_dt = datetime.strptime(str(prev_wk_dt)[:8], '%Y%m%d')
                        return_days.append((cur_dt - prv_dt).days)
                    except (ValueError, TypeError):
                        pass

            avg_return = round(sum(return_days) / len(return_days), 1) if return_days else 0

            # 초교배일령 계산 (SANCHA=0 AND GYOBAE_CNT=1)
            first_gb_days = []
            first_gb_cnt = 0
            for wk in week_gb:
                sancha = wk.get('SANCHA') or 0
                gyobae_cnt = wk.get('GYOBAE_CNT') or 0
                if sancha == 0 and gyobae_cnt == 1:
                    first_gb_cnt += 1
                    modon_no = str(wk.get('MODON_NO', ''))
                    birth_dt = modon_birth.get(modon_no)
                    wk_dt = wk.get('WK_DT')
                    if birth_dt and wk_dt:
                        try:
                            cur_dt = datetime.strptime(str(wk_dt)[:8], '%Y%m%d')
                            bir_dt = datetime.strptime(str(birth_dt)[:8], '%Y%m%d')
                            first_gb_days.append((cur_dt - bir_dt).days)
                        except (ValueError, TypeError):
                            pass

            avg_first_gb = round(sum(first_gb_days) / len(first_gb_days), 1) if first_gb_days else 0

            # 재교배 건수 (GYOBAE_CNT > 1)
            sago_gb_cnt = sum(1 for wk in week_gb if (wk.get('GYOBAE_CNT') or 0) > 1)

            # 정상교배 건수 (GYOBAE_CNT = 1)
            js_gb_cnt = sum(1 for wk in week_gb if (wk.get('GYOBAE_CNT') or 0) == 1)

            stats = {
                'total_cnt': total_cnt,
                'sago_cnt': sago_cnt,
                'bunman_cnt': bunman_cnt,
                'avg_return': avg_return,
                'avg_first_gb': avg_first_gb,
                'first_gb_cnt': first_gb_cnt,
                'sago_gb_cnt': sago_gb_cnt,
                'js_gb_cnt': js_gb_cnt,
            }

        # INSERT
        sql_ins = """
        INSERT INTO TS_INS_WEEK_SUB (
            MASTER_SEQ, FARM_NO, GUBUN, SUB_GUBUN, SORT_NO,
            CNT_1, CNT_2, CNT_3, VAL_1, VAL_2, CNT_4, CNT_5, CNT_6,
            CNT_7, CNT_8, CNT_9
        ) VALUES (
            :master_seq, :farm_no, 'GB', 'STAT', 1,
            :total_cnt, :sago_cnt, :bunman_cnt, :avg_return, :avg_first_gb,
            :first_gb_cnt, :sago_gb_cnt, :js_gb_cnt, :plan_hubo, :plan_js, :acc_gb_cnt
        )
        """
        self.execute(sql_ins, {
            'master_seq': self.master_seq,
            'farm_no': self.farm_no,
            'total_cnt': stats.get('total_cnt', 0),
            'sago_cnt': stats.get('sago_cnt', 0),
            'bunman_cnt': stats.get('bunman_cnt', 0),
            'avg_return': stats.get('avg_return', 0),
            'avg_first_gb': stats.get('avg_first_gb', 0),
            'first_gb_cnt': stats.get('first_gb_cnt', 0),
            'sago_gb_cnt': stats.get('sago_gb_cnt', 0),
            'js_gb_cnt': stats.get('js_gb_cnt', 0),
            'plan_hubo': plan_hubo,
            'plan_js': plan_js,
            'acc_gb_cnt': acc_gb_cnt,
        })

        return stats

    def _insert_chart(self, dt_from: str, dt_to: str) -> int:
        """재귀일별 교배복수 차트 INSERT (1 ROW로 통합)

        데이터 소스 우선순위:
        1. TS_PRODUCTIVITY API 데이터 (PCODE='031', C029~C036)
        2. SQL 계산값 (API 데이터 없을 경우)

        x축 구간 (8개): 3일이내, 4일, 5일, 6일, 7일, 8일, 9일, 10일이상
        컬럼 매핑:
        - CNT_1 (C029): ~3일재귀복수
        - CNT_2 (C030): 4일재귀복수
        - CNT_3 (C031): 5일재귀복수
        - CNT_4 (C032): 6일재귀복수
        - CNT_5 (C033): 7일재귀복수
        - CNT_6 (C034): 8일재귀복수
        - CNT_7 (C035): 9일재귀복수
        - CNT_8 (C036): 10일↑재귀복수
        """
        # 1. TS_PRODUCTIVITY에서 API 데이터 조회 (PCODE='031')
        api_data = self._get_productivity_chart_data()

        # 2. API 데이터 있으면 사용, 없으면 SQL 계산
        if api_data:
            self.logger.info(f"GB_CHART: API 데이터 사용 (PCODE=031)")
            return self._insert_chart_from_api(api_data)
        else:
            self.logger.info(f"GB_CHART: SQL 계산값 사용 (API 데이터 없음)")
            return self._insert_chart_from_sql(dt_from, dt_to)

    def _get_productivity_chart_data(self) -> dict:
        """TS_PRODUCTIVITY에서 재귀일별 데이터 조회 (PCODE='031')

        Returns:
            API 데이터 딕셔너리 {'C029': 값, ...} 또는 None
        """
        # 리포트 년도/주차 조회
        sql_week = """
        SELECT REPORT_YEAR, REPORT_WEEK_NO
        FROM TS_INS_WEEK
        WHERE MASTER_SEQ = :master_seq AND FARM_NO = :farm_no
        """
        week_result = self.fetch_one(sql_week, {
            'master_seq': self.master_seq,
            'farm_no': self.farm_no,
        })

        if not week_result:
            return None

        report_year, report_week = week_result[0], week_result[1]

        # TS_PRODUCTIVITY 조회 (PCODE='031')
        sql = """
        SELECT C029, C030, C031, C032, C033, C034, C035, C036
        FROM TS_PRODUCTIVITY
        WHERE FARM_NO = :farm_no
          AND PCODE = '031'
          AND STAT_YEAR = :report_year
          AND PERIOD = 'W'
          AND PERIOD_NO = :report_week
        """
        result = self.fetch_one(sql, {
            'farm_no': self.farm_no,
            'report_year': report_year,
            'report_week': report_week,
        })

        if not result:
            return None

        return {
            'C029': result[0],
            'C030': result[1],
            'C031': result[2],
            'C032': result[3],
            'C033': result[4],
            'C034': result[5],
            'C035': result[6],
            'C036': result[7],
        }

    def _insert_chart_from_api(self, api_data: dict) -> int:
        """API 데이터로 차트 INSERT (1 ROW)

        CNT_1~CNT_8에 각 재귀일 구간별 복수 저장
        """
        insert_sql = """
        INSERT INTO TS_INS_WEEK_SUB (
            MASTER_SEQ, FARM_NO, GUBUN, SUB_GUBUN, SORT_NO,
            CNT_1, CNT_2, CNT_3, CNT_4, CNT_5, CNT_6, CNT_7, CNT_8
        ) VALUES (
            :master_seq, :farm_no, 'GB', 'CHART', 1,
            :cnt_1, :cnt_2, :cnt_3, :cnt_4, :cnt_5, :cnt_6, :cnt_7, :cnt_8
        )
        """

        self.execute(insert_sql, {
            'master_seq': self.master_seq,
            'farm_no': self.farm_no,
            'cnt_1': int(api_data.get('C029') or 0),  # ~3일
            'cnt_2': int(api_data.get('C030') or 0),  # 4일
            'cnt_3': int(api_data.get('C031') or 0),  # 5일
            'cnt_4': int(api_data.get('C032') or 0),  # 6일
            'cnt_5': int(api_data.get('C033') or 0),  # 7일
            'cnt_6': int(api_data.get('C034') or 0),  # 8일
            'cnt_7': int(api_data.get('C035') or 0),  # 9일
            'cnt_8': int(api_data.get('C036') or 0),  # 10일↑
        })

        return 1

    def _insert_chart_from_sql(self, dt_from: str, dt_to: str) -> int:
        """SQL 계산값으로 차트 INSERT (1 ROW)

        재귀일 구간별로 집계하여 CNT_1~CNT_8에 저장
        - CNT_1: ~3일, CNT_2: 4일, ..., CNT_8: 10일↑
        """
        insert_sql = """
        INSERT INTO TS_INS_WEEK_SUB (
            MASTER_SEQ, FARM_NO, GUBUN, SUB_GUBUN, SORT_NO,
            CNT_1, CNT_2, CNT_3, CNT_4, CNT_5, CNT_6, CNT_7, CNT_8
        )
        SELECT :master_seq, :farm_no, 'GB', 'CHART', 1,
               NVL(SUM(CASE WHEN RETURN_DAY <= 3 THEN 1 END), 0),  -- CNT_1: ~3일
               NVL(SUM(CASE WHEN RETURN_DAY = 4 THEN 1 END), 0),   -- CNT_2: 4일
               NVL(SUM(CASE WHEN RETURN_DAY = 5 THEN 1 END), 0),   -- CNT_3: 5일
               NVL(SUM(CASE WHEN RETURN_DAY = 6 THEN 1 END), 0),   -- CNT_4: 6일
               NVL(SUM(CASE WHEN RETURN_DAY = 7 THEN 1 END), 0),   -- CNT_5: 7일
               NVL(SUM(CASE WHEN RETURN_DAY = 8 THEN 1 END), 0),   -- CNT_6: 8일
               NVL(SUM(CASE WHEN RETURN_DAY = 9 THEN 1 END), 0),   -- CNT_7: 9일
               NVL(SUM(CASE WHEN RETURN_DAY >= 10 THEN 1 END), 0)  -- CNT_8: 10일↑
        FROM (
            SELECT TO_DATE(A.WK_DT, 'YYYYMMDD') - TO_DATE(E.WK_DT, 'YYYYMMDD') AS RETURN_DAY
            FROM TB_MODON_WK A
            LEFT OUTER JOIN (
                SELECT FARM_NO, PIG_NO, WK_DT,
                       ROW_NUMBER() OVER (PARTITION BY FARM_NO, PIG_NO ORDER BY SEQ DESC) AS RN
                FROM TB_MODON_WK
                WHERE FARM_NO = :farm_no AND WK_GUBUN = 'E' AND USE_YN = 'Y'
            ) E ON E.FARM_NO = A.FARM_NO AND E.PIG_NO = A.PIG_NO AND E.RN = 1
            WHERE A.FARM_NO = :farm_no
              AND A.WK_GUBUN = 'G'
              AND A.USE_YN = 'Y'
              AND A.WK_DT >= :dt_from
              AND A.WK_DT <= :dt_to
              AND NOT (A.SANCHA = 0 AND A.GYOBAE_CNT = 1)
              AND E.WK_DT IS NOT NULL
        )
        """

        self.execute(insert_sql, {
            'master_seq': self.master_seq,
            'farm_no': self.farm_no,
            'dt_from': dt_from,
            'dt_to': dt_to,
        })

        return 1

    def _update_week(self, total_cnt: int, acc_gb_cnt: int) -> None:
        """TS_INS_WEEK 메인 테이블 업데이트"""
        sql = """
        UPDATE TS_INS_WEEK
        SET LAST_GB_CNT = :total_cnt,
            LAST_GB_SUM = :acc_gb_cnt
        WHERE MASTER_SEQ = :master_seq AND FARM_NO = :farm_no
        """
        self.execute(sql, {
            'total_cnt': total_cnt,
            'acc_gb_cnt': acc_gb_cnt,
            'master_seq': self.master_seq,
            'farm_no': self.farm_no,
        })

    def _insert_hint(self, ins_conf: Dict[str, Any], prev_hint: Optional[str] = None) -> None:
        """예정 산출기준 힌트 메시지를 STAT ROW의 HINT1 컬럼에 UPDATE

        교배 팝업에서 예정 복수 산출 기준을 표시하기 위한 힌트 저장.
        기존: 별도 SUB_GUBUN='HINT' ROW로 INSERT
        변경: 기존 STAT ROW의 HINT1 컬럼에 UPDATE (데이터 절감)

        Args:
            ins_conf: TS_INS_CONF 설정 (method, tasks, seq_filter)
            prev_hint: 이전 주차에서 조회한 힌트 (있으면 우선 사용)
        """
        # 이전 주차 힌트가 있으면 그대로 사용
        if prev_hint is not None:
            hint = prev_hint
            self.logger.info(f"이전 주차 힌트 사용")
        elif ins_conf['method'] == 'farm':
            # 농장 기본값: TC_FARM_CONFIG 설정값 포함
            farm_config = self._get_farm_config()
            hint = (
                f"(농장 기본값)\n"
                f"· 이유돈(평균재귀일) {farm_config['avg_return_day']}일\n"
                f"· 후보돈(초교배일령) {farm_config['first_mating_age']}일\n"
                f"· 사고/재발돈 즉시"
            )
        else:
            # 모돈 작업설정
            seq_filter = ins_conf['seq_filter']
            if seq_filter == '':
                hint = "(모돈 작업설정)\n· 선택된 작업 없음"
            else:
                # TB_PLAN_MODON에서 선택된 작업 이름과 경과일 조회 (각 작업별 줄바꿈)
                sql = """
                SELECT LISTAGG('· ' || WK_NM || '(' || PASS_DAY || '일)', CHR(10)) WITHIN GROUP (ORDER BY WK_NM)
                FROM TB_PLAN_MODON
                WHERE FARM_NO = :farm_no AND JOB_GUBUN_CD = '150005' AND USE_YN = 'Y'
                  AND SEQ IN ({})
                """.format(seq_filter)
                result = self.fetch_one(sql, {'farm_no': self.farm_no})
                task_names = result[0] if result and result[0] else ''
                hint = f"(모돈 작업설정)\n{task_names}"

        # UPDATE: 기존 STAT ROW의 HINT1 컬럼에 저장
        sql = """
        UPDATE TS_INS_WEEK_SUB
        SET HINT1 = :hint
        WHERE MASTER_SEQ = :master_seq
          AND FARM_NO = :farm_no
          AND GUBUN = 'GB'
          AND SUB_GUBUN = 'STAT'
        """
        self.execute(sql, {
            'master_seq': self.master_seq,
            'farm_no': self.farm_no,
            'hint': hint,
        })

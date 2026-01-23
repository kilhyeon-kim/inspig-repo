"""
이유 팝업 데이터 추출 프로세서
SP_INS_WEEK_EU_POPUP 프로시저 Python 전환

역할:
- 이유 요약 통계 (GUBUN='EU')
- TB_MODON_WK + TB_EU + TB_BUNMAN 조인
- 자돈 증감 내역 (TB_MODON_JADON_TRANS)
- 포유개시 계산 (실산 - 폐사 + 양자전입 - 양자전출)
- TS_INS_WEEK 이유 관련 컬럼 업데이트

TS_INS_CONF 설정 지원:
- method='farm': 농장 기본값 사용 (TC_FARM_CONFIG)
- method='modon': 모돈 작업설정 사용 (FN_MD_SCHEDULE_BSE_2020)
"""
import json
import logging
from datetime import datetime
from typing import Any, Dict, Optional

from .base import BaseProcessor

logger = logging.getLogger(__name__)


class WeaningProcessor(BaseProcessor):
    """이유 팝업 프로세서"""

    PROC_NAME = 'WeaningProcessor'

    def process(self, dt_from: str, dt_to: str, **kwargs) -> Dict[str, Any]:
        """이유 데이터 추출

        Args:
            dt_from: 시작일 (YYYYMMDD)
            dt_to: 종료일 (YYYYMMDD)

        Returns:
            처리 결과 딕셔너리
        """
        self.logger.info(f"이유 팝업 시작: 농장={self.farm_no}, 기간={dt_from}~{dt_to}")

        # 날짜 포맷 변환
        sdt = f"{dt_from[:4]}-{dt_from[4:6]}-{dt_from[6:8]}"
        edt = f"{dt_to[:4]}-{dt_to[4:6]}-{dt_to[6:8]}"

        # 날짜 객체 변환
        dt_from_obj = datetime.strptime(dt_from, '%Y%m%d')
        dt_to_obj = datetime.strptime(dt_to, '%Y%m%d')

        # 1. 기존 데이터 삭제
        self._delete_existing()

        # 2. TS_INS_CONF 설정 조회 (금주 작업예정 산정방식)
        ins_conf = self._get_ins_conf()

        # 3. 이유 예정 복수 조회 (설정에 따라 분기)
        plan_eu, prev_hint = self._get_plan_count(sdt, edt, dt_from_obj, dt_to_obj, ins_conf)

        # 4. 연간 누적 실적 조회
        acc_stats = self._get_acc_stats(dt_to)

        # 5. 이유 통계 집계 및 INSERT (자돈 증감 포함)
        stats = self._insert_stats(dt_from, dt_to, plan_eu, acc_stats)

        # 6. 힌트 메시지 INSERT (산출 기준 설명)
        # prev_hint가 있으면 이전 주차 힌트 사용, 없으면 현재 설정으로 생성
        self._insert_hint(ins_conf, prev_hint)

        # 7. TS_INS_WEEK 업데이트
        self._update_week(stats, acc_stats)

        self.logger.info(f"이유 팝업 완료: 농장={self.farm_no}, 이유복수={stats.get('total_cnt', 0)}")

        return {
            'status': 'success',
            **stats,
        }

    def _delete_existing(self) -> None:
        """기존 EU 데이터 삭제"""
        sql = """
        DELETE FROM TS_INS_WEEK_SUB
        WHERE MASTER_SEQ = :master_seq AND FARM_NO = :farm_no AND GUBUN = 'EU'
        """
        self.execute(sql, {'master_seq': self.master_seq, 'farm_no': self.farm_no})

    def _get_ins_conf(self) -> Dict[str, Any]:
        """TS_INS_CONF에서 이유예정 산정방식 설정 조회

        Returns:
            {'method': 'farm'|'modon', 'tasks': [], 'seq_filter': ''}
            TS_INS_CONF 설정이 없으면 modon 전체 방식으로 처리 (pig3.1 화면 기준)
        """
        # 기본값: pig3.1 InsWeeklyConfigPopup.jsp 화면 기본값과 동일 (modon)
        default_conf = {'method': 'modon', 'tasks': None, 'seq_filter': '-1'}

        sql = """
        SELECT WEEK_TW_EU
        FROM TS_INS_CONF
        WHERE FARM_NO = :farm_no
        """
        result = self.fetch_one(sql, {'farm_no': self.farm_no})

        if not result or not result[0]:
            self.logger.info(f"TS_INS_CONF 이유 설정 없음, modon 전체 사용: farm_no={self.farm_no}")
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
            self.logger.info(f"TS_INS_CONF 이유 설정 로드: farm_no={self.farm_no}, conf={conf}")
            return conf
        except json.JSONDecodeError:
            self.logger.warning(f"JSON 파싱 실패: WEEK_TW_EU={result[0]}")
            return default_conf

    def _get_farm_config(self) -> Dict[str, int]:
        """TC_FARM_CONFIG에서 이유예정 계산에 필요한 설정값 조회

        Returns:
            {'wean_period': 평균포유기간 (140003, 기본 21일)}
        """
        sql = """
        SELECT CODE, TO_NUMBER(NVL(CVALUE, '21'))
        FROM TC_FARM_CONFIG
        WHERE FARM_NO = :farm_no AND CODE = '140003'
        """
        cursor = self.conn.cursor()
        try:
            cursor.execute(sql, {'farm_no': self.farm_no})
            rows = cursor.fetchall()

            config = {'wean_period': 21}

            for code, value in rows:
                if code == '140003':
                    config['wean_period'] = int(value) if value else 21

            self.logger.info(f"TC_FARM_CONFIG 이유 설정 조회: farm_no={self.farm_no}, config={config}")
            return config
        finally:
            cursor.close()

    def _get_plan_from_prev_week(self) -> Optional[tuple]:
        """이전 주차 금주예정에서 이유 예정 조회 (힌트 포함)

        조회 우선순위:
        1. SCHEDULE/EU 상세 데이터 (method='modon'일 때 저장됨) → CNT_1 합산
        2. TS_INS_WEEK.THIS_EU_SUM (method='farm'일 때도 저장됨) → Fallback

        Returns:
            (plan_eu, hint) 또는 None (이전 주차 데이터 없음)
        """
        # 이전 주차의 MASTER_SEQ 조회 (base.py 헬퍼 사용)
        prev_master_seq = self._get_prev_week_master_seq()
        if not prev_master_seq:
            return None

        # 1. 힌트 정보 조회 (SUB_GUBUN='HELP', STR_3=이유예정 힌트)
        sql_hint = """
        SELECT STR_3
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

        # 2. SCHEDULE/- 요약 데이터에서 이유 합계 조회
        # CNT_4 = eu_sum (이유예정 합계)
        sql_summary = """
        SELECT CNT_4
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
            plan_eu = summary_result[0] or 0
            self.logger.info(f"이전 주차 금주예정 조회: 이유합계={plan_eu}")
            return (plan_eu, hint)

        return None

    def _get_plan_count(self, sdt: str, edt: str, dt_from: datetime, dt_to: datetime,
                        ins_conf: Dict[str, Any]) -> tuple:
        """이유 예정 복수 조회 (이전 주차 우선 조회)

        1차: 이전 주차 금주예정 조회
        2차: 이전 주차 없으면 직접 계산 (Fallback)

        Args:
            sdt: 시작일 (yyyy-MM-dd)
            edt: 종료일 (yyyy-MM-dd)
            dt_from: 시작일 (datetime)
            dt_to: 종료일 (datetime)
            ins_conf: TS_INS_CONF 설정

        Returns:
            (이유 예정 복수, 힌트) 튜플
        """
        # 1. 이전 주차 금주예정 조회 시도
        prev_data = self._get_plan_from_prev_week()
        if prev_data is not None:
            year, week_no = self._get_current_week_info()
            self.logger.info(f"이전 주차 금주예정 사용: year={year}, week={week_no}")
            return prev_data  # (plan_eu, hint) 반환

        # 2. Fallback: 이전 주차 없으면 직접 계산
        self.logger.info("직접 계산 (Fallback): 이전 주차 데이터 없음")
        return self._calculate_plan_count(sdt, edt, dt_from, dt_to, ins_conf)

    def _calculate_plan_count(self, sdt: str, edt: str, dt_from: datetime, dt_to: datetime,
                              ins_conf: Dict[str, Any]) -> tuple:
        """이유 예정 복수 직접 계산 (기존 로직)

        Args:
            sdt: 시작일 (yyyy-MM-dd)
            edt: 종료일 (yyyy-MM-dd)
            dt_from: 시작일 (datetime)
            dt_to: 종료일 (datetime)
            ins_conf: TS_INS_CONF 설정

        Returns:
            (이유 예정 복수, None) 튜플 - 힌트는 _insert_hint()에서 생성
        """
        if ins_conf['method'] == 'farm':
            return self._count_plan_by_farm(dt_from, dt_to), None
        else:
            return self._count_plan_by_modon(sdt, edt, ins_conf['seq_filter']), None

    def _count_plan_by_modon(self, sdt: str, edt: str, seq_filter: str) -> int:
        """모돈 작업설정 기준 이유 예정 복수 조회 (FN_MD_SCHEDULE_BSE_2020)"""
        if seq_filter == '':
            self.logger.info("이유 작업 없음 (seq_filter=''), 카운트 생략")
            return 0

        sql = """
        SELECT COUNT(*)
        FROM TABLE(FN_MD_SCHEDULE_BSE_2020(
            :farm_no, 'JOB-DAJANG', '150003', NULL,
            :sdt, :edt, NULL, 'ko', 'yyyy-MM-dd', :seq_filter, NULL
        ))
        """
        result = self.fetch_one(sql, {'farm_no': self.farm_no, 'sdt': sdt, 'edt': edt, 'seq_filter': seq_filter})
        return result[0] if result else 0

    def _count_plan_by_farm(self, dt_from: datetime, dt_to: datetime) -> int:
        """농장 기본값 기준 이유 예정 복수 조회

        TC_FARM_CONFIG 설정값을 사용하여 예정일 계산:
        - 이유예정: 분만일 + 평균포유기간 (기본 21일)
        """
        farm_config = self._get_farm_config()
        wean_period = farm_config['wean_period']

        # 이유예정: 분만(B) 작업일 + 평균포유기간 = 이유예정일
        sql = """
        SELECT COUNT(*)
        FROM TB_MODON_WK WB
        INNER JOIN TB_MODON MD
            ON MD.FARM_NO = :farm_no
           AND MD.FARM_NO = WB.FARM_NO
           AND MD.PIG_NO = WB.PIG_NO
           AND MD.USE_YN = 'Y'
        WHERE WB.FARM_NO = :farm_no
          AND WB.WK_GUBUN = 'B'
          AND WB.WK_DT >= TO_CHAR(:dt_from - :wean_period, 'YYYYMMDD')
          AND WB.WK_DT < TO_CHAR(:dt_to + 1 - :wean_period, 'YYYYMMDD')
          AND WB.USE_YN = 'Y'
        """
        result = self.fetch_one(sql, {
            'farm_no': self.farm_no,
            'dt_from': dt_from,
            'dt_to': dt_to,
            'wean_period': wean_period,
        })
        plan_eu = result[0] if result else 0

        self.logger.info(f"농장기본값 이유예정: {plan_eu}")
        return plan_eu

    def _get_acc_stats(self, dt_to: str) -> Dict[str, Any]:
        """연간 누적 실적 조회 (1/1 ~ 기준일)

        data_loader.eu 데이터를 필터링하여 계산
        """
        year_start = dt_to[:4] + '0101'

        if not self.data_loader:
            return {'acc_eu_cnt': 0, 'acc_eu_jd': 0, 'acc_avg_jd': 0}

        data = self.data_loader.get_data()
        eu_list = data.get('eu', [])

        # 연간 이유 데이터 필터링
        filtered = [
            e for e in eu_list
            if e.get('EU_DT') and year_start <= str(e['EU_DT'])[:8] <= dt_to
        ]

        if not filtered:
            return {'acc_eu_cnt': 0, 'acc_eu_jd': 0, 'acc_avg_jd': 0}

        acc_eu_cnt = len(filtered)
        acc_eu_jd = sum(e.get('EU_CNT') or 0 for e in filtered)
        acc_avg_jd = round(acc_eu_jd / acc_eu_cnt, 1) if acc_eu_cnt > 0 else 0

        return {
            'acc_eu_cnt': acc_eu_cnt,
            'acc_eu_jd': acc_eu_jd,
            'acc_avg_jd': acc_avg_jd,
        }

    def _insert_stats(self, dt_from: str, dt_to: str, plan_eu: int, acc_stats: Dict) -> Dict[str, Any]:
        """이유 통계 집계 및 INSERT (자돈 증감 포함)

        WITH절로 사전 집계:
        - JADON_TRANS_AGG: 자돈 증감 내역 (SANCHA+WK_DT 기준)
        - JADON_POGAE_AGG: 포유개시용 (BUN_DT 기준)
        - NEXT_WK: 다음 작업일 계산
        - JADON_PERIOD_AGG: 기간별 자돈 증감 합계
        """
        sql = """
        WITH
        JADON_TRANS_AGG AS (
            SELECT JT.FARM_NO, JT.PIG_NO, JT.SANCHA, TO_CHAR(JT.WK_DT, 'YYYYMMDD') AS WK_DT,
                   SUM(CASE WHEN JT.GUBUN_CD = '160001' THEN NVL(JT.DUSU,0)+NVL(JT.DUSU_SU,0) ELSE 0 END) AS PS_DS,
                   SUM(CASE WHEN JT.GUBUN_CD = '160002' THEN NVL(JT.DUSU,0)+NVL(JT.DUSU_SU,0) ELSE 0 END) AS BB_DS,
                   SUM(CASE WHEN JT.GUBUN_CD = '160003' THEN NVL(JT.DUSU,0)+NVL(JT.DUSU_SU,0) ELSE 0 END) AS JI_DS,
                   SUM(CASE WHEN JT.GUBUN_CD = '160004' THEN NVL(JT.DUSU,0)+NVL(JT.DUSU_SU,0) ELSE 0 END) AS JC_DS
            FROM TB_MODON_JADON_TRANS JT
            WHERE JT.FARM_NO = :farm_no AND JT.USE_YN = 'Y'
            GROUP BY JT.FARM_NO, JT.PIG_NO, JT.SANCHA, TO_CHAR(JT.WK_DT, 'YYYYMMDD')
        ),
        JADON_POGAE_AGG AS (
            SELECT JT.FARM_NO, JT.PIG_NO, TO_CHAR(JT.BUN_DT, 'YYYYMMDD') AS BUN_DT,
                   SUM(CASE WHEN JT.GUBUN_CD = '160001' THEN NVL(JT.DUSU,0)+NVL(JT.DUSU_SU,0) ELSE 0 END) AS PS_DS,
                   SUM(CASE WHEN JT.GUBUN_CD = '160003' THEN NVL(JT.DUSU,0)+NVL(JT.DUSU_SU,0) ELSE 0 END) AS JI_DS,
                   SUM(CASE WHEN JT.GUBUN_CD = '160004' THEN NVL(JT.DUSU,0)+NVL(JT.DUSU_SU,0) ELSE 0 END) AS JC_DS
            FROM TB_MODON_JADON_TRANS JT
            WHERE JT.FARM_NO = :farm_no AND JT.USE_YN = 'Y'
            GROUP BY JT.FARM_NO, JT.PIG_NO, TO_CHAR(JT.BUN_DT, 'YYYYMMDD')
        ),
        NEXT_WK AS (
            SELECT FARM_NO, PIG_NO, WK_DT AS CUR_WK_DT,
                   MIN(NEXT_WK_DT) AS NEXT_WK_DT, MIN(NEXT_WK_GUBUN) KEEP (DENSE_RANK FIRST ORDER BY NEXT_WK_DT) AS NEXT_WK_GUBUN
            FROM (
                SELECT A.FARM_NO, A.PIG_NO, A.WK_DT,
                       B.WK_DT AS NEXT_WK_DT, B.WK_GUBUN AS NEXT_WK_GUBUN
                FROM TB_MODON_WK A
                INNER JOIN TB_MODON_WK B
                    ON B.FARM_NO = A.FARM_NO AND B.PIG_NO = A.PIG_NO
                   AND B.WK_DT > A.WK_DT AND B.USE_YN = 'Y'
                WHERE A.FARM_NO = :farm_no
                  AND A.WK_GUBUN = 'E'
                  AND A.USE_YN = 'Y'
                  AND A.WK_DT >= :dt_from
                  AND A.WK_DT <= :dt_to
            )
            GROUP BY FARM_NO, PIG_NO, WK_DT
        ),
        JADON_PERIOD_AGG AS (
            SELECT A.FARM_NO, A.PIG_NO, A.SANCHA, A.WK_DT AS EU_WK_DT, B.WK_DT AS BM_WK_DT,
                   NVL(SUM(JT.PS_DS), 0) AS SUM_PS_DS,
                   NVL(SUM(JT.BB_DS), 0) AS SUM_BB_DS,
                   NVL(SUM(JT.JI_DS), 0) AS SUM_JI_DS,
                   NVL(SUM(JT.JC_DS), 0) AS SUM_JC_DS
            FROM TB_MODON_WK A
            INNER JOIN TB_MODON_WK B
                ON B.FARM_NO = A.FARM_NO AND B.PIG_NO = A.PIG_NO
               AND B.SANCHA = A.SANCHA AND B.WK_GUBUN = 'B' AND B.USE_YN = 'Y'
            LEFT OUTER JOIN NEXT_WK NW
                ON NW.FARM_NO = A.FARM_NO AND NW.PIG_NO = A.PIG_NO AND NW.CUR_WK_DT = A.WK_DT
            LEFT OUTER JOIN JADON_TRANS_AGG JT
                ON JT.FARM_NO = A.FARM_NO AND JT.PIG_NO = A.PIG_NO AND JT.SANCHA = A.SANCHA
               AND JT.WK_DT >= B.WK_DT
               AND JT.WK_DT <= CASE WHEN NW.NEXT_WK_GUBUN = 'G' THEN NW.NEXT_WK_DT
                                    WHEN NW.NEXT_WK_DT IS NULL AND NVL(A.DAERI_YN, 'N') = 'N' THEN :dt_to
                                    WHEN A.WK_DT IS NULL OR LENGTH(TRIM(A.WK_DT)) != 8 THEN :dt_to
                                    ELSE TO_CHAR(TO_DATE(A.WK_DT, 'YYYYMMDD') - 1, 'YYYYMMDD') END
            WHERE A.FARM_NO = :farm_no
              AND A.WK_GUBUN = 'E'
              AND A.USE_YN = 'Y'
              AND A.WK_DT >= :dt_from
              AND A.WK_DT <= :dt_to
            GROUP BY A.FARM_NO, A.PIG_NO, A.SANCHA, A.WK_DT, B.WK_DT
        )
        SELECT
            COUNT(*),
            NVL(SUM(NVL(D.DUSU, 0) + NVL(D.DUSU_SU, 0)), 0),
            NVL(SUM(NVL(E.SILSAN, 0) + NVL(E.SASAN, 0) + NVL(E.MILA, 0)), 0),
            NVL(SUM(NVL(E.SILSAN, 0)), 0),
            NVL(SUM(CASE WHEN A.WK_DT IS NOT NULL AND B.WK_DT IS NOT NULL
                         AND LENGTH(TRIM(A.WK_DT)) = 8 AND LENGTH(TRIM(B.WK_DT)) = 8
                         THEN TO_DATE(A.WK_DT, 'YYYYMMDD') - TO_DATE(B.WK_DT, 'YYYYMMDD') ELSE 0 END), 0),
            NVL(SUM(NVL(D.TOTAL_KG, 0)), 0),
            NVL(ROUND(AVG(NVL(D.DUSU, 0) + NVL(D.DUSU_SU, 0)), 1), 0),
            NVL(ROUND(AVG(CASE WHEN A.WK_DT IS NOT NULL AND B.WK_DT IS NOT NULL
                               AND LENGTH(TRIM(A.WK_DT)) = 8 AND LENGTH(TRIM(B.WK_DT)) = 8
                               THEN TO_DATE(A.WK_DT, 'YYYYMMDD') - TO_DATE(B.WK_DT, 'YYYYMMDD') ELSE NULL END), 1), 0),
            NVL(SUM(PA.SUM_PS_DS), 0),
            NVL(SUM(PA.SUM_BB_DS), 0),
            NVL(SUM(PA.SUM_JI_DS), 0),
            NVL(SUM(PA.SUM_JC_DS), 0),
            NVL(SUM(
                NVL(E.SILSAN, 0)
                - NVL(PO.PS_DS, 0)
                + NVL(PO.JI_DS, 0)
                - NVL(PO.JC_DS, 0)
            ), 0)
        FROM TB_MODON_WK A
        INNER JOIN TB_EU D
            ON D.FARM_NO = A.FARM_NO AND D.PIG_NO = A.PIG_NO
           AND D.WK_DT = A.WK_DT AND D.WK_GUBUN = A.WK_GUBUN AND D.USE_YN = 'Y'
        INNER JOIN TB_MODON_WK B
            ON B.FARM_NO = A.FARM_NO AND B.PIG_NO = A.PIG_NO
           AND B.SANCHA = A.SANCHA AND B.WK_GUBUN = 'B' AND B.USE_YN = 'Y'
        INNER JOIN TB_BUNMAN E
            ON E.FARM_NO = B.FARM_NO AND E.PIG_NO = B.PIG_NO
           AND E.WK_DT = B.WK_DT AND E.WK_GUBUN = B.WK_GUBUN AND E.USE_YN = 'Y'
        LEFT OUTER JOIN JADON_PERIOD_AGG PA
            ON PA.FARM_NO = A.FARM_NO AND PA.PIG_NO = A.PIG_NO
           AND PA.SANCHA = A.SANCHA AND PA.EU_WK_DT = A.WK_DT
        LEFT OUTER JOIN JADON_POGAE_AGG PO
            ON PO.FARM_NO = A.FARM_NO AND PO.PIG_NO = A.PIG_NO AND PO.BUN_DT = B.WK_DT
        WHERE A.FARM_NO = :farm_no
          AND A.WK_GUBUN = 'E'
          AND A.USE_YN = 'Y'
          AND A.WK_DT >= :dt_from
          AND A.WK_DT <= :dt_to
        """
        result = self.fetch_one(sql, {'farm_no': self.farm_no, 'dt_from': dt_from, 'dt_to': dt_to})

        total_cnt = result[0] if result else 0
        sum_eudusu = result[1] if result else 0
        sum_chongsan = result[2] if result else 0
        sum_silsan = result[3] if result else 0
        sum_pougigan = result[4] if result else 0
        sum_kg = result[5] if result else 0
        avg_eudusu = result[6] if result else 0
        avg_pougigan = result[7] if result else 0
        sum_ps_ds = result[8] if result else 0
        sum_bb_ds = result[9] if result else 0
        sum_ji_ds = result[10] if result else 0
        sum_jc_ds = result[11] if result else 0
        sum_pogae = result[12] if result else 0

        # 평균체중 계산 (TOTAL_KG / 총이유두수) - 이유자돈 평균체중
        avg_kg = round(sum_kg / sum_eudusu, 2) if sum_eudusu > 0 else 0

        # 이유육성율 계산 (이유두수 / 실산 * 100)
        survival_rate = round(sum_eudusu / sum_silsan * 100, 1) if sum_silsan > 0 else 0

        # 평균 이유두수 증감 계산 (지난주 평균 - 1년 평균)
        chg_jd = round(avg_eudusu - acc_stats['acc_avg_jd'], 1) if acc_stats['acc_avg_jd'] > 0 else 0

        stats = {
            'total_cnt': total_cnt,
            'sum_eudusu': sum_eudusu,
            'sum_chongsan': sum_chongsan,
            'sum_silsan': sum_silsan,
            'sum_pougigan': sum_pougigan,
            'avg_eudusu': avg_eudusu,
            'avg_kg': avg_kg,
            'avg_pougigan': avg_pougigan,
            'survival_rate': survival_rate,
            'sum_pogae': sum_pogae,
            'sum_ps_ds': sum_ps_ds,
            'sum_bb_ds': sum_bb_ds,
            'sum_ji_ds': sum_ji_ds,
            'sum_jc_ds': sum_jc_ds,
            'chg_jd': chg_jd,
            'plan_eu': plan_eu,
        }

        # INSERT
        sql_ins = """
        INSERT INTO TS_INS_WEEK_SUB (
            MASTER_SEQ, FARM_NO, GUBUN, SORT_NO,
            CNT_1, CNT_2, CNT_3, CNT_4, CNT_5,
            CNT_6, CNT_7, CNT_8, CNT_9,
            VAL_1, VAL_2, VAL_3, VAL_4, VAL_5,
            STR_1
        ) VALUES (
            :master_seq, :farm_no, 'EU', 1,
            :total_cnt, :sum_eudusu, :sum_silsan, :sum_pougigan, :plan_eu,
            :sum_ps_ds, :sum_bb_ds, :sum_ji_ds, :sum_jc_ds,
            :avg_eudusu, :avg_kg, :survival_rate, :avg_pougigan, :sum_pogae,
            TO_CHAR(:sum_chongsan)
        )
        """
        self.execute(sql_ins, {
            'master_seq': self.master_seq,
            'farm_no': self.farm_no,
            'total_cnt': stats.get('total_cnt', 0),
            'sum_eudusu': stats.get('sum_eudusu', 0),
            'sum_silsan': stats.get('sum_silsan', 0),
            'sum_pougigan': stats.get('sum_pougigan', 0),
            'plan_eu': stats.get('plan_eu', 0),
            'sum_ps_ds': stats.get('sum_ps_ds', 0),
            'sum_bb_ds': stats.get('sum_bb_ds', 0),
            'sum_ji_ds': stats.get('sum_ji_ds', 0),
            'sum_jc_ds': stats.get('sum_jc_ds', 0),
            'avg_eudusu': stats.get('avg_eudusu', 0),
            'avg_kg': stats.get('avg_kg', 0),
            'survival_rate': stats.get('survival_rate', 0),
            'avg_pougigan': stats.get('avg_pougigan', 0),
            'sum_pogae': stats.get('sum_pogae', 0),
            'sum_chongsan': stats.get('sum_chongsan', 0),
        })

        return stats

    def _update_week(self, stats: Dict[str, Any], acc_stats: Dict[str, Any]) -> None:
        """TS_INS_WEEK 이유 관련 컬럼 업데이트"""
        sql = """
        UPDATE TS_INS_WEEK
        SET LAST_EU_CNT = :total_cnt,
            LAST_EU_JD_CNT = :sum_eudusu,
            LAST_EU_AVG_JD = :avg_eudusu,
            LAST_EU_AVG_KG = :avg_kg,
            LAST_EU_SUM_CNT = :acc_eu_cnt,
            LAST_EU_SUM_JD = :acc_eu_jd,
            LAST_EU_SUM_AVG_JD = :acc_avg_jd,
            LAST_EU_CHG_JD = :chg_jd
        WHERE MASTER_SEQ = :master_seq AND FARM_NO = :farm_no
        """
        self.execute(sql, {
            'master_seq': self.master_seq,
            'farm_no': self.farm_no,
            'total_cnt': stats.get('total_cnt', 0),
            'sum_eudusu': stats.get('sum_eudusu', 0),
            'avg_eudusu': stats.get('avg_eudusu', 0),
            'avg_kg': stats.get('avg_kg', 0),
            'chg_jd': stats.get('chg_jd', 0),
            'acc_eu_cnt': acc_stats.get('acc_eu_cnt', 0),
            'acc_eu_jd': acc_stats.get('acc_eu_jd', 0),
            'acc_avg_jd': acc_stats.get('acc_avg_jd', 0),
        })

    def _insert_hint(self, ins_conf: Dict[str, Any], prev_hint: Optional[str] = None) -> None:
        """예정 산출기준 힌트 메시지를 STAT ROW의 HINT1 컬럼에 UPDATE

        이유 팝업에서 예정 복수 산출 기준을 표시하기 위한 힌트 저장.
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
                f"· 포유모돈(평균포유기간) {farm_config['wean_period']}일"
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
                WHERE FARM_NO = :farm_no AND JOB_GUBUN_CD = '150003' AND USE_YN = 'Y'
                  AND SEQ IN ({})
                """.format(seq_filter)
                result = self.fetch_one(sql, {'farm_no': self.farm_no})
                task_names = result[0] if result and result[0] else ''
                hint = f"(모돈 작업설정)\n{task_names}"

        # UPDATE: 기존 STAT ROW의 HINT1 컬럼에 저장 (EU는 SUB_GUBUN 없음)
        sql = """
        UPDATE TS_INS_WEEK_SUB
        SET HINT1 = :hint
        WHERE MASTER_SEQ = :master_seq
          AND FARM_NO = :farm_no
          AND GUBUN = 'EU'
          AND SORT_NO = 1
        """
        self.execute(sql, {
            'master_seq': self.master_seq,
            'farm_no': self.farm_no,
            'hint': hint,
        })

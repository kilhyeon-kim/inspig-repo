"""
분만 팝업 데이터 추출 프로세서
SP_INS_WEEK_BM_POPUP 프로시저 Python 전환

역할:
- 분만 요약 통계 (GUBUN='BM')
- TB_MODON_WK + TB_BUNMAN 조인
- 포유개시 계산 (자돈 증감 포함)

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


class FarrowingProcessor(BaseProcessor):
    """분만 팝업 프로세서"""

    PROC_NAME = 'FarrowingProcessor'

    def process(self, dt_from: str, dt_to: str, **kwargs) -> Dict[str, Any]:
        """분만 데이터 추출

        Args:
            dt_from: 시작일 (YYYYMMDD)
            dt_to: 종료일 (YYYYMMDD)

        Returns:
            처리 결과 딕셔너리
        """
        self.logger.info(f"분만 팝업 시작: 농장={self.farm_no}, 기간={dt_from}~{dt_to}")

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

        # 3. 분만 예정 복수 조회 (설정에 따라 분기)
        plan_bm, prev_hint = self._get_plan_count(sdt, edt, dt_from_obj, dt_to_obj, ins_conf)

        # 4. 연간 누적 실적 조회
        acc_stats = self._get_acc_stats(dt_to)

        # 5. 분만 통계 집계 및 INSERT
        stats = self._insert_stats(dt_from, dt_to, plan_bm, acc_stats)

        # 6. 힌트 메시지 INSERT (산출 기준 설명)
        # prev_hint가 있으면 이전 주차 힌트 사용, 없으면 현재 설정으로 생성
        self._insert_hint(ins_conf, prev_hint)

        # 7. TS_INS_WEEK 업데이트
        self._update_week(stats, acc_stats)

        self.logger.info(f"분만 팝업 완료: 농장={self.farm_no}, 분만복수={stats.get('total_cnt', 0)}")

        return {
            'status': 'success',
            **stats,
        }

    def _delete_existing(self) -> None:
        """기존 BM 데이터 삭제"""
        sql = """
        DELETE FROM TS_INS_WEEK_SUB
        WHERE MASTER_SEQ = :master_seq AND FARM_NO = :farm_no AND GUBUN = 'BM'
        """
        self.execute(sql, {'master_seq': self.master_seq, 'farm_no': self.farm_no})

    def _get_ins_conf(self) -> Dict[str, Any]:
        """TS_INS_CONF에서 분만예정 산정방식 설정 조회

        Returns:
            {'method': 'farm'|'modon'|None, 'tasks': [], 'seq_filter': ''}
            method=None이면 설정 없음 (예정 복수 산출 안 함)
        """
        # 기본값: 설정 없음 (예정 복수 산출 안 함)
        default_conf = {'method': None, 'tasks': None, 'seq_filter': ''}

        sql = """
        SELECT WEEK_TW_BM
        FROM TS_INS_CONF
        WHERE FARM_NO = :farm_no
        """
        result = self.fetch_one(sql, {'farm_no': self.farm_no})

        if not result or not result[0]:
            self.logger.info(f"TS_INS_CONF 분만 설정 없음, 예정 복수 산출 안 함: farm_no={self.farm_no}")
            return default_conf

        try:
            parsed = json.loads(result[0])
            method = parsed.get('method', 'farm')
            tasks = parsed.get('tasks') if 'tasks' in parsed else None

            if method == 'modon':
                if tasks is None or len(tasks) == 0:
                    seq_filter = ''  # 빈 배열이면 작업 없음
                else:
                    seq_filter = ','.join(str(t) for t in tasks)
            else:
                seq_filter = '-1'

            conf = {'method': method, 'tasks': tasks, 'seq_filter': seq_filter}
            self.logger.info(f"TS_INS_CONF 분만 설정 로드: farm_no={self.farm_no}, conf={conf}")
            return conf
        except json.JSONDecodeError:
            self.logger.warning(f"JSON 파싱 실패: WEEK_TW_BM={result[0]}")
            return default_conf

    def _get_farm_config(self) -> Dict[str, int]:
        """TC_FARM_CONFIG에서 분만예정 계산에 필요한 설정값 조회

        Returns:
            {'preg_period': 평균임신기간 (140002, 기본 115일)}
        """
        sql = """
        SELECT CODE, TO_NUMBER(NVL(CVALUE, '115'))
        FROM TC_FARM_CONFIG
        WHERE FARM_NO = :farm_no AND CODE = '140002'
        """
        cursor = self.conn.cursor()
        try:
            cursor.execute(sql, {'farm_no': self.farm_no})
            rows = cursor.fetchall()

            config = {'preg_period': 115}

            for code, value in rows:
                if code == '140002':
                    config['preg_period'] = int(value) if value else 115

            self.logger.info(f"TC_FARM_CONFIG 분만 설정 조회: farm_no={self.farm_no}, config={config}")
            return config
        finally:
            cursor.close()

    def _get_plan_from_prev_week(self) -> Optional[tuple]:
        """이전 주차 금주예정에서 분만 예정 조회 (힌트 포함)

        조회 우선순위:
        1. SCHEDULE/BM 상세 데이터 (method='modon'일 때 저장됨) → CNT_1 합산
        2. TS_INS_WEEK.THIS_BM_SUM (method='farm'일 때도 저장됨) → Fallback

        Returns:
            (plan_bm, hint) 또는 None (이전 주차 데이터 없음)
        """
        # 이전 주차의 MASTER_SEQ 조회 (base.py 헬퍼 사용)
        prev_master_seq = self._get_prev_week_master_seq()
        if not prev_master_seq:
            return None

        # 1. 힌트 정보 조회 (SUB_GUBUN='HELP', STR_2=분만예정 힌트)
        sql_hint = """
        SELECT STR_2
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

        # 2. SCHEDULE/- 요약 데이터에서 분만 합계 조회
        # CNT_3 = bm_sum (분만예정 합계)
        sql_summary = """
        SELECT CNT_3
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
            plan_bm = summary_result[0] or 0
            self.logger.info(f"이전 주차 금주예정 조회: 분만합계={plan_bm}")
            return (plan_bm, hint)

        return None

    def _get_plan_count(self, sdt: str, edt: str, dt_from: datetime, dt_to: datetime,
                        ins_conf: Dict[str, Any]) -> tuple:
        """분만 예정 복수 조회 (이전 주차 우선 조회)

        1차: 이전 주차 금주예정 조회
        2차: 이전 주차 없으면 직접 계산 (Fallback)

        Args:
            sdt: 시작일 (yyyy-MM-dd)
            edt: 종료일 (yyyy-MM-dd)
            dt_from: 시작일 (datetime)
            dt_to: 종료일 (datetime)
            ins_conf: TS_INS_CONF 설정

        Returns:
            (분만 예정 복수, 힌트) 튜플
        """
        # 1. 이전 주차 금주예정 조회 시도
        prev_data = self._get_plan_from_prev_week()
        if prev_data is not None:
            year, week_no = self._get_current_week_info()
            self.logger.info(f"이전 주차 금주예정 사용: year={year}, week={week_no}")
            return prev_data  # (plan_bm, hint) 반환

        # 2. Fallback: 이전 주차 없으면 직접 계산
        self.logger.info("직접 계산 (Fallback): 이전 주차 데이터 없음")
        return self._calculate_plan_count(sdt, edt, dt_from, dt_to, ins_conf)

    def _calculate_plan_count(self, sdt: str, edt: str, dt_from: datetime, dt_to: datetime,
                              ins_conf: Dict[str, Any]) -> tuple:
        """분만 예정 복수 직접 계산 (기존 로직)

        Args:
            sdt: 시작일 (yyyy-MM-dd)
            edt: 종료일 (yyyy-MM-dd)
            dt_from: 시작일 (datetime)
            dt_to: 종료일 (datetime)
            ins_conf: TS_INS_CONF 설정

        Returns:
            (분만 예정 복수, None) 튜플 - 힌트는 _insert_hint()에서 생성
        """
        if ins_conf['method'] is None:
            self.logger.info("분만 예정 설정 없음, 예정 복수 산출 안 함")
            return 0, None
        elif ins_conf['method'] == 'farm':
            return self._count_plan_by_farm(dt_from, dt_to), None
        else:
            return self._count_plan_by_modon(sdt, edt, ins_conf['seq_filter']), None

    def _count_plan_by_modon(self, sdt: str, edt: str, seq_filter: str) -> int:
        """모돈 작업설정 기준 분만 예정 복수 조회 (FN_MD_SCHEDULE_BSE_2020)"""
        if seq_filter == '':
            self.logger.info("분만 작업 없음 (seq_filter=''), 카운트 생략")
            return 0

        sql = """
        SELECT COUNT(*)
        FROM TABLE(FN_MD_SCHEDULE_BSE_2020(
            :farm_no, 'JOB-DAJANG', '150002', NULL,
            :sdt, :edt, NULL, 'ko', 'yyyy-MM-dd', :seq_filter, NULL
        ))
        """
        result = self.fetch_one(sql, {'farm_no': self.farm_no, 'sdt': sdt, 'edt': edt, 'seq_filter': seq_filter})
        return result[0] if result else 0

    def _count_plan_by_farm(self, dt_from: datetime, dt_to: datetime) -> int:
        """농장 기본값 기준 분만 예정 복수 조회

        TC_FARM_CONFIG 설정값을 사용하여 예정일 계산:
        - 분만예정: 교배일 + 평균임신기간 (기본 115일)
        """
        farm_config = self._get_farm_config()
        preg_period = farm_config['preg_period']

        # 분만예정: 교배(G) 작업 중 다음 SEQ가 사고(F)가 아닌 모돈
        # 교배일 + 평균임신기간 = 분만예정일
        sql = """
        SELECT COUNT(*)
        FROM TB_MODON_WK WG
        INNER JOIN TB_MODON MD
            ON MD.FARM_NO = :farm_no
           AND MD.FARM_NO = WG.FARM_NO
           AND MD.PIG_NO = WG.PIG_NO
           AND MD.USE_YN = 'Y'
        LEFT OUTER JOIN TB_MODON_WK WF
            ON WF.FARM_NO = :farm_no
           AND WF.FARM_NO = WG.FARM_NO
           AND WF.PIG_NO = WG.PIG_NO
           AND WF.SEQ = WG.SEQ + 1
           AND WF.WK_GUBUN = 'F'
           AND WF.USE_YN = 'Y'
        WHERE WG.FARM_NO = :farm_no
          AND WG.WK_GUBUN = 'G'
          AND WG.WK_DT >= TO_CHAR(:dt_from - :preg_period, 'YYYYMMDD')
          AND WG.WK_DT < TO_CHAR(:dt_to + 1 - :preg_period, 'YYYYMMDD')
          AND WF.PIG_NO IS NULL
          AND WG.USE_YN = 'Y'
        """
        result = self.fetch_one(sql, {
            'farm_no': self.farm_no,
            'dt_from': dt_from,
            'dt_to': dt_to,
            'preg_period': preg_period,
        })
        plan_bm = result[0] if result else 0

        self.logger.info(f"농장기본값 분만예정: {plan_bm}")
        return plan_bm

    def _get_acc_stats(self, dt_to: str) -> Dict[str, Any]:
        """연간 누적 실적 조회 (1/1 ~ 기준일)

        data_loader.bunman 데이터를 필터링하여 계산
        """
        year_start = dt_to[:4] + '0101'

        if not self.data_loader:
            return {'acc_bm_cnt': 0, 'acc_total': 0, 'acc_live': 0, 'acc_avg_total': 0, 'acc_avg_live': 0}

        data = self.data_loader.get_data()
        bunman_list = data.get('bunman', [])

        # 연간 데이터 필터링 (BUN_DT 기준)
        filtered = [
            b for b in bunman_list
            if b.get('BUN_DT') and year_start <= str(b['BUN_DT'])[:8] <= dt_to
        ]

        if not filtered:
            return {'acc_bm_cnt': 0, 'acc_total': 0, 'acc_live': 0, 'acc_avg_total': 0, 'acc_avg_live': 0}

        acc_bm_cnt = len(filtered)
        acc_total = sum((b.get('SILSAN') or 0) + (b.get('SASAN') or 0) + (b.get('MUMMY') or 0) for b in filtered)
        acc_live = sum(b.get('SILSAN') or 0 for b in filtered)
        acc_avg_total = round(acc_total / acc_bm_cnt, 1) if acc_bm_cnt > 0 else 0
        acc_avg_live = round(acc_live / acc_bm_cnt, 1) if acc_bm_cnt > 0 else 0

        return {
            'acc_bm_cnt': acc_bm_cnt,
            'acc_total': acc_total,
            'acc_live': acc_live,
            'acc_avg_total': acc_avg_total,
            'acc_avg_live': acc_avg_live,
        }

    def _insert_stats(self, dt_from: str, dt_to: str, plan_bm: int, acc_stats: Dict) -> Dict[str, Any]:
        """분만 통계 집계 및 INSERT (포유개시 포함)

        data_loader.bunman, jadon_trans 데이터를 필터링하여 계산
        """
        if not self.data_loader:
            stats = {'total_cnt': 0, 'sum_total': 0, 'sum_live': 0, 'sum_dead': 0,
                     'sum_mummy': 0, 'sum_sdotae': 0, 'sum_yangja': 0, 'sum_pogae': 0,
                     'avg_total': 0, 'avg_live': 0, 'avg_dead': 0, 'avg_mummy': 0,
                     'avg_sdotae': 0, 'avg_yangja': 0, 'avg_pogae': 0}
        else:
            data = self.data_loader.get_data()
            bunman_list = data.get('bunman', [])
            jadon_trans = data.get('jadon_trans', [])

            # 주간 분만 데이터 필터링
            week_bunman = [
                b for b in bunman_list
                if b.get('BUN_DT') and dt_from <= str(b['BUN_DT'])[:8] <= dt_to
            ]

            # 자돈 증감 집계 (모돈+분만일 기준)
            # ps: 포유사고(생시도태), ji: 자돈입(양자전입), jc: 자돈출(양자전출)
            jadon_agg = {}  # {(modon_no, bun_dt): {'ps': 0, 'ji': 0, 'jc': 0}}
            for jt in jadon_trans:
                modon_no = str(jt.get('MODON_NO', ''))
                bun_dt = str(jt.get('BUN_DT', '') or '')[:8]
                gubun_cd = str(jt.get('TRANS_GUBUN_CD', '') or '')
                trans_cnt = jt.get('TRANS_CNT') or 0

                if not modon_no or not bun_dt:
                    continue

                key = (modon_no, bun_dt)
                if key not in jadon_agg:
                    jadon_agg[key] = {'ps': 0, 'ji': 0, 'jc': 0}

                if gubun_cd == '160001':  # 포유사고 (생시도태)
                    jadon_agg[key]['ps'] += trans_cnt
                elif gubun_cd == '160003':  # 자돈입 (양자전입)
                    jadon_agg[key]['ji'] += trans_cnt
                elif gubun_cd == '160004':  # 자돈출 (양자전출)
                    jadon_agg[key]['jc'] += trans_cnt

            # 통계 계산
            total_cnt = len(week_bunman)
            sum_live = sum(b.get('SILSAN') or 0 for b in week_bunman)
            sum_dead = sum(b.get('SASAN') or 0 for b in week_bunman)
            sum_mummy = sum(b.get('MUMMY') or 0 for b in week_bunman)
            sum_total = sum_live + sum_dead + sum_mummy

            # 자돈 증감 집계 (생시도태, 양자, 포유개시)
            sdotae_list = []  # 생시도태 (포유사고)
            yangja_list = []  # 양자 (전입 - 전출)
            pogae_list = []   # 포유개시 (실산 - 생시도태 + 양자)

            for b in week_bunman:
                modon_no = str(b.get('MODON_NO', ''))
                bun_dt = str(b.get('BUN_DT', '') or '')[:8]
                silsan = b.get('SILSAN') or 0
                key = (modon_no, bun_dt)
                adj = jadon_agg.get(key, {'ps': 0, 'ji': 0, 'jc': 0})

                sdotae = adj['ps']  # 생시도태
                yangja = adj['ji'] - adj['jc']  # 양자 (전입 - 전출)
                pogae = silsan - sdotae + yangja  # 포유개시

                sdotae_list.append(sdotae)
                yangja_list.append(yangja)
                pogae_list.append(pogae)

            sum_sdotae = sum(sdotae_list)
            sum_yangja = sum(yangja_list)
            sum_pogae = sum(pogae_list)

            # 평균 계산
            avg_total = round(sum_total / total_cnt, 1) if total_cnt > 0 else 0
            avg_live = round(sum_live / total_cnt, 1) if total_cnt > 0 else 0
            avg_dead = round(sum_dead / total_cnt, 1) if total_cnt > 0 else 0
            avg_mummy = round(sum_mummy / total_cnt, 1) if total_cnt > 0 else 0
            avg_sdotae = round(sum_sdotae / total_cnt, 1) if total_cnt > 0 else 0
            avg_yangja = round(sum_yangja / total_cnt, 1) if total_cnt > 0 else 0
            avg_pogae = round(sum_pogae / total_cnt, 1) if total_cnt > 0 else 0

            stats = {
                'total_cnt': total_cnt,
                'sum_total': sum_total,
                'sum_live': sum_live,
                'sum_dead': sum_dead,
                'sum_mummy': sum_mummy,
                'sum_sdotae': sum_sdotae,
                'sum_yangja': sum_yangja,
                'sum_pogae': sum_pogae,
                'avg_total': avg_total,
                'avg_live': avg_live,
                'avg_dead': avg_dead,
                'avg_mummy': avg_mummy,
                'avg_sdotae': avg_sdotae,
                'avg_yangja': avg_yangja,
                'avg_pogae': avg_pogae,
            }

        # INSERT
        # CNT_1: 분만복수, CNT_2: 총산합계, CNT_3: 실산합계, CNT_4: 사산합계
        # CNT_5: 미라합계, CNT_6: 포유개시합계, CNT_7: 분만예정
        # CNT_8: 생시도태합계, CNT_9: 양자합계
        # VAL_1~5: 평균(총산,실산,사산,미라,포유개시)
        # VAL_6: 평균생시도태, VAL_7: 평균양자
        sql_ins = """
        INSERT INTO TS_INS_WEEK_SUB (
            MASTER_SEQ, FARM_NO, GUBUN, SORT_NO,
            CNT_1, CNT_2, CNT_3, CNT_4, CNT_5, CNT_6, CNT_7, CNT_8, CNT_9,
            VAL_1, VAL_2, VAL_3, VAL_4, VAL_5, VAL_6, VAL_7
        ) VALUES (
            :master_seq, :farm_no, 'BM', 1,
            :total_cnt, :sum_total, :sum_live, :sum_dead, :sum_mummy, :sum_pogae, :plan_bm, :sum_sdotae, :sum_yangja,
            :avg_total, :avg_live, :avg_dead, :avg_mummy, :avg_pogae, :avg_sdotae, :avg_yangja
        )
        """
        self.execute(sql_ins, {
            'master_seq': self.master_seq,
            'farm_no': self.farm_no,
            'plan_bm': plan_bm,
            'total_cnt': stats.get('total_cnt', 0),
            'sum_total': stats.get('sum_total', 0),
            'sum_live': stats.get('sum_live', 0),
            'sum_dead': stats.get('sum_dead', 0),
            'sum_mummy': stats.get('sum_mummy', 0),
            'sum_sdotae': stats.get('sum_sdotae', 0),
            'sum_yangja': stats.get('sum_yangja', 0),
            'sum_pogae': stats.get('sum_pogae', 0),
            'avg_total': stats.get('avg_total', 0),
            'avg_live': stats.get('avg_live', 0),
            'avg_dead': stats.get('avg_dead', 0),
            'avg_mummy': stats.get('avg_mummy', 0),
            'avg_sdotae': stats.get('avg_sdotae', 0),
            'avg_yangja': stats.get('avg_yangja', 0),
            'avg_pogae': stats.get('avg_pogae', 0),
        })

        return stats

    def _update_week(self, stats: Dict[str, Any], acc_stats: Dict[str, Any]) -> None:
        """TS_INS_WEEK 분만 관련 컬럼 업데이트"""
        sql = """
        UPDATE TS_INS_WEEK
        SET LAST_BM_CNT = :total_cnt,
            LAST_BM_TOTAL = :sum_total,
            LAST_BM_LIVE = :sum_live,
            LAST_BM_DEAD = :sum_dead,
            LAST_BM_MUMMY = :sum_mummy,
            LAST_BM_AVG_TOTAL = :avg_total,
            LAST_BM_AVG_LIVE = :avg_live,
            LAST_BM_SUM_CNT = :acc_bm_cnt,
            LAST_BM_SUM_TOTAL = :acc_total,
            LAST_BM_SUM_LIVE = :acc_live,
            LAST_BM_SUM_AVG_TOTAL = :acc_avg_total,
            LAST_BM_SUM_AVG_LIVE = :acc_avg_live
        WHERE MASTER_SEQ = :master_seq AND FARM_NO = :farm_no
        """
        self.execute(sql, {
            'master_seq': self.master_seq,
            'farm_no': self.farm_no,
            'total_cnt': stats.get('total_cnt', 0),
            'sum_total': stats.get('sum_total', 0),
            'sum_live': stats.get('sum_live', 0),
            'sum_dead': stats.get('sum_dead', 0),
            'sum_mummy': stats.get('sum_mummy', 0),
            'avg_total': stats.get('avg_total', 0),
            'avg_live': stats.get('avg_live', 0),
            'acc_bm_cnt': acc_stats.get('acc_bm_cnt', 0),
            'acc_total': acc_stats.get('acc_total', 0),
            'acc_live': acc_stats.get('acc_live', 0),
            'acc_avg_total': acc_stats.get('acc_avg_total', 0),
            'acc_avg_live': acc_stats.get('acc_avg_live', 0),
        })

    def _insert_hint(self, ins_conf: Dict[str, Any], prev_hint: Optional[str] = None) -> None:
        """예정 산출기준 힌트 메시지를 STAT ROW의 HINT1 컬럼에 UPDATE

        분만 팝업에서 예정 복수 산출 기준을 표시하기 위한 힌트 저장.
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
        elif ins_conf['method'] is None:
            # 설정 없으면 힌트 저장 안 함
            return
        elif ins_conf['method'] == 'farm':
            # 농장 기본값: TC_FARM_CONFIG 설정값 포함
            farm_config = self._get_farm_config()
            hint = (
                f"(농장 기본값)\n"
                f"· 임신모돈(평균임신기간) {farm_config['preg_period']}일"
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
                WHERE FARM_NO = :farm_no AND JOB_GUBUN_CD = '150002' AND USE_YN = 'Y'
                  AND SEQ IN ({})
                """.format(seq_filter)
                result = self.fetch_one(sql, {'farm_no': self.farm_no})
                task_names = result[0] if result and result[0] else ''
                hint = f"(모돈 작업설정)\n{task_names}"

        # UPDATE: 기존 STAT ROW의 HINT1 컬럼에 저장 (BM은 SUB_GUBUN 없음)
        sql = """
        UPDATE TS_INS_WEEK_SUB
        SET HINT1 = :hint
        WHERE MASTER_SEQ = :master_seq
          AND FARM_NO = :farm_no
          AND GUBUN = 'BM'
          AND SORT_NO = 1
        """
        self.execute(sql, {
            'master_seq': self.master_seq,
            'farm_no': self.farm_no,
            'hint': hint,
        })

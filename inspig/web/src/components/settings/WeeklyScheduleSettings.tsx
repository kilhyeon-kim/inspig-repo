"use client";

import { useState, useEffect } from 'react';
import { configApi, FarmConfigResponse, PlanModonItem } from '@/services/api';

// 산정 방식 타입
type ScheduleCalcMethod = 'farm' | 'modon';

// 스케줄 항목
const SCHEDULE_ITEMS = [
    { key: 'mating', label: '교배' },
    { key: 'farrowing', label: '분만' },
    { key: 'pregnancyCheck', label: '임신 감정돈(진단)' },
    { key: 'weaning', label: '이유' },
    { key: 'vaccine', label: '모돈백신' },
] as const;

type ScheduleItemKey = typeof SCHEDULE_ITEMS[number]['key'];

// 농장 기본값 정보
interface FarmDefaultItem {
    targetGroup: string;
    settingName: string;
    value: string;
}

// 모돈 작업설정 데이터
interface ModonTask {
    seq: number;
    taskNm: string;
    targetGroup: string;
    elapsedDays: string;
}

// itemKey → planModon 키 매핑
const PLAN_KEY_MAP: Record<ScheduleItemKey, string> = {
    mating: 'mating',
    farrowing: 'farrowing',
    pregnancyCheck: 'pregnancy',
    weaning: 'weaning',
    vaccine: 'vaccine',
};

interface WeeklyScheduleSettingsProps {
    farmNo: number;
    showSaveButton?: boolean;
    readOnly?: boolean;
    onSave?: () => void;
    onClose?: () => void;
}

export default function WeeklyScheduleSettings({
    farmNo,
    showSaveButton = true,
    readOnly = false,
    onSave,
    onClose,
}: WeeklyScheduleSettingsProps) {
    // API 로딩 상태
    const [loading, setLoading] = useState(true);
    const [farmConfigData, setFarmConfigData] = useState<FarmConfigResponse | null>(null);

    // 각 작업 구분별 산정 방식 (farm/modon)
    // 기본값: 교배/이유/백신은 modon, 분만/임신감정은 farm
    const [scheduleCalcMethods, setScheduleCalcMethods] = useState<Record<ScheduleItemKey, ScheduleCalcMethod>>({
        mating: 'modon',
        farrowing: 'farm',
        pregnancyCheck: 'farm',
        weaning: 'modon',
        vaccine: 'modon',
    });

    // 모돈 작업설정 선택 시 선택된 작업들 (seq 기준)
    const [selectedModonTasks, setSelectedModonTasks] = useState<Record<ScheduleItemKey, number[]>>({
        mating: [],
        farrowing: [],
        pregnancyCheck: [],
        weaning: [],
        vaccine: [],
    });

    // 저장 상태
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    // 농장 설정 로드
    useEffect(() => {
        const loadFarmConfig = async () => {
            if (!farmNo) {
                setLoading(false);
                return;
            }
            try {
                const data = await configApi.getFarmConfig(farmNo);
                setFarmConfigData(data);
            } catch (error) {
                console.error('농장 설정 로드 실패:', error);
            } finally {
                setLoading(false);
            }
        };
        loadFarmConfig();
    }, [farmNo]);

    // farmConfigData 로드 후 insConf 기반으로 초기화
    useEffect(() => {
        if (farmConfigData) {
            const { insConf, planModon } = farmConfigData;

            // 모든 작업 seq 가져오기 (기본 선택용)
            const getAllTaskSeqs = (planKey: string): number[] => {
                const jobs = planModon[planKey] || [];
                return jobs.map((j: PlanModonItem) => j.seq);
            };

            // 1. 산정 방식 초기화 (기본값: 교배/이유/백신은 modon, 분만/임신감정은 farm)
            const newMethods: Record<ScheduleItemKey, ScheduleCalcMethod> = {
                mating: (insConf.mating?.method as ScheduleCalcMethod) || 'modon',
                farrowing: (insConf.farrowing?.method as ScheduleCalcMethod) || 'farm',
                pregnancyCheck: (insConf.pregnancy?.method as ScheduleCalcMethod) || 'farm',
                weaning: (insConf.weaning?.method as ScheduleCalcMethod) || 'modon',
                vaccine: 'modon',
            };
            setScheduleCalcMethods(newMethods);

            // 2. 선택된 작업 초기화
            // - insConf에 tasks가 있으면 그대로 사용
            // - insConf에 tasks가 빈 배열이면 planModon 전체 선택 (단, planModon이 있을 때만)
            const getTasksOrAll = (insConfKey: string, planKey: string): number[] => {
                const tasks = insConf[insConfKey]?.tasks || [];
                const allTasks = getAllTaskSeqs(planKey);
                // tasks가 있으면 그대로, 없으면 전체 선택 (planModon이 있을 때만)
                return tasks.length > 0 ? tasks : allTasks;
            };

            const newSelected: Record<ScheduleItemKey, number[]> = {
                mating: getTasksOrAll('mating', 'mating'),
                farrowing: getTasksOrAll('farrowing', 'farrowing'),
                pregnancyCheck: getTasksOrAll('pregnancy', 'pregnancy'),
                weaning: getTasksOrAll('weaning', 'weaning'),
                vaccine: getTasksOrAll('vaccine', 'vaccine'),
            };
            setSelectedModonTasks(newSelected);
        }
    }, [farmConfigData]);

    // API 데이터를 화면용 데이터로 변환
    const getFarmDefaults = (itemKey: ScheduleItemKey): FarmDefaultItem[] => {
        if (!farmConfigData) return [];
        const { farmConfig } = farmConfigData;

        switch (itemKey) {
            case 'mating':
                return [
                    { targetGroup: '이유돈', settingName: '평균재귀일', value: `${farmConfig['140008']?.value || 7}일` },
                    { targetGroup: '후보돈', settingName: '초교배일령', value: `${farmConfig['140007']?.value || 240}일` },
                    { targetGroup: '사고/재발돈', settingName: '', value: '즉시' },
                ];
            case 'farrowing':
                return [
                    { targetGroup: '임신모돈', settingName: '평균임신기간', value: `${farmConfig['140002']?.value || 115}일` },
                ];
            case 'pregnancyCheck':
                return [
                    { targetGroup: '재발확인', settingName: '', value: '교배 후 3주' },
                    { targetGroup: '임신진단', settingName: '', value: '교배 후 4주' },
                ];
            case 'weaning':
                return [
                    { targetGroup: '포유모돈', settingName: '평균포유기간', value: `${farmConfig['140003']?.value || 21}일` },
                ];
            case 'vaccine':
                return [];
            default:
                return [];
        }
    };

    // 모돈 작업설정 데이터 가져오기
    const getModonTasks = (itemKey: ScheduleItemKey): ModonTask[] => {
        if (!farmConfigData) return [];
        const planKey = PLAN_KEY_MAP[itemKey];
        const jobs = farmConfigData.planModon[planKey] || [];
        return jobs.map((job: PlanModonItem) => ({
            seq: job.seq,
            taskNm: job.name,
            targetGroup: job.targetSow,
            elapsedDays: `${job.elapsedDays}일`,
        }));
    };

    const handleScheduleMethodChange = (itemKey: ScheduleItemKey, method: ScheduleCalcMethod) => {
        setScheduleCalcMethods(prev => ({ ...prev, [itemKey]: method }));
    };

    const handleModonTaskToggle = (itemKey: ScheduleItemKey, taskSeq: number) => {
        setSelectedModonTasks(prev => {
            const currentSelected = prev[itemKey];
            const isSelected = currentSelected.includes(taskSeq);

            // 최소 1개 유지 (백신은 0개 허용)
            if (isSelected && currentSelected.length <= 1 && itemKey !== 'vaccine') {
                return prev;
            }

            const newSelected = isSelected
                ? currentSelected.filter(t => t !== taskSeq)
                : [...currentSelected, taskSeq];

            return { ...prev, [itemKey]: newSelected };
        });
    };

    // 저장
    const handleSave = async () => {
        if (!farmNo) return;

        // 검증 (백신은 작업정보가 없을 수 있으므로 예외)
        for (const itemKey of Object.keys(scheduleCalcMethods) as ScheduleItemKey[]) {
            if (scheduleCalcMethods[itemKey] === 'modon' && itemKey !== 'vaccine') {
                const tasks = selectedModonTasks[itemKey] || [];
                if (tasks.length === 0) {
                    const label = SCHEDULE_ITEMS.find(s => s.key === itemKey)?.label || itemKey;
                    setMessage({ type: 'error', text: `${label}: 모돈 작업설정 선택 시 최소 1개 이상의 작업을 선택해야 합니다.` });
                    return;
                }
            }
        }

        // 확인 메시지
        const confirmed = window.confirm(
            '변경된 설정은 차주 보고서 발송부터 반영됩니다.\n계속하시겠습니까?'
        );
        if (!confirmed) return;

        setSaving(true);
        setMessage(null);

        try {
            // farm 선택 시 tasks는 빈 배열로 저장
            const settings = {
                mating: { method: scheduleCalcMethods.mating, tasks: scheduleCalcMethods.mating === 'farm' ? [] : selectedModonTasks.mating },
                farrowing: { method: scheduleCalcMethods.farrowing, tasks: scheduleCalcMethods.farrowing === 'farm' ? [] : selectedModonTasks.farrowing },
                pregnancy: { method: scheduleCalcMethods.pregnancyCheck, tasks: scheduleCalcMethods.pregnancyCheck === 'farm' ? [] : selectedModonTasks.pregnancyCheck },
                weaning: { method: scheduleCalcMethods.weaning, tasks: scheduleCalcMethods.weaning === 'farm' ? [] : selectedModonTasks.weaning },
                vaccine: { method: 'modon' as const, tasks: selectedModonTasks.vaccine },
            };

            await configApi.saveWeeklySettings(farmNo, settings);
            setMessage({ type: 'success', text: '저장되었습니다.' });
            onSave?.();

            setTimeout(() => setMessage(null), 3000);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '저장에 실패했습니다.';
            setMessage({ type: 'error', text: errorMessage });
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
            </div>
        );
    }

    return (
        <div id="weekly-schedule-settings">
            <div className="px-4 py-4 lg:px-6">
                {/* 작업 항목별 설정 */}
                <div className="space-y-2 lg:grid lg:grid-cols-2 lg:gap-3 lg:space-y-0">
                    {SCHEDULE_ITEMS.map((item) => {
                        const isModon = scheduleCalcMethods[item.key] === 'modon';
                        const isVaccine = item.key === 'vaccine';
                        const farmDefaults = getFarmDefaults(item.key);
                        const modonTasks = getModonTasks(item.key);
                        const selectedTasks = selectedModonTasks[item.key] || [];

                        return (
                            <div
                                key={item.key}
                                id={`schedule-${item.key}`}
                                className={`border rounded-lg transition-all ${
                                    isModon
                                        ? 'border-green-300 dark:border-green-700 bg-green-50/50 dark:bg-green-900/10'
                                        : 'border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-900/10'
                                }`}
                            >
                                {/* 작업 구분 헤더 */}
                                <div className="flex items-center justify-between px-4 py-3">
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm lg:text-base font-medium text-gray-700 dark:text-gray-300">
                                            {item.label}
                                        </span>
                                    </div>

                                    {/* 산정 방식 선택 */}
                                    <div className="flex items-center gap-3 lg:gap-4">
                                        <label
                                            onClick={() => !readOnly && !isVaccine && handleScheduleMethodChange(item.key, 'farm')}
                                            className={`flex items-center gap-1.5 lg:gap-2 ${readOnly || isVaccine ? 'cursor-default' : 'cursor-pointer'} ${isVaccine ? 'opacity-50' : ''}`}
                                        >
                                            <span className={`w-3.5 h-3.5 lg:w-4 lg:h-4 rounded-full border-2 flex items-center justify-center ${
                                                !isModon && !isVaccine
                                                    ? 'border-blue-500 bg-blue-500'
                                                    : 'border-gray-300 dark:border-gray-500'
                                            }`}>
                                                {!isModon && !isVaccine && <span className="w-1.5 h-1.5 lg:w-2 lg:h-2 rounded-full bg-white" />}
                                            </span>
                                            <span className={`text-xs lg:text-sm ${
                                                !isModon && !isVaccine
                                                    ? 'text-blue-600 dark:text-blue-400 font-medium'
                                                    : 'text-gray-500 dark:text-gray-400'
                                            }`}>
                                                {item.key === 'farrowing' ? (
                                                    <>
                                                        농장 기본값
                                                        <span className="block lg:inline text-[10px] lg:text-xs text-gray-400">(분만예정돈 대장)</span>
                                                    </>
                                                ) : '농장 기본값'}
                                            </span>
                                        </label>
                                        <label
                                            onClick={() => !readOnly && handleScheduleMethodChange(item.key, 'modon')}
                                            className={`flex items-center gap-1.5 lg:gap-2 ${readOnly ? 'cursor-default' : 'cursor-pointer'}`}
                                        >
                                            <span className={`w-3.5 h-3.5 lg:w-4 lg:h-4 rounded-full border-2 flex items-center justify-center ${
                                                isModon || isVaccine
                                                    ? 'border-green-500 bg-green-500'
                                                    : 'border-gray-300 dark:border-gray-500'
                                            }`}>
                                                {(isModon || isVaccine) && <span className="w-1.5 h-1.5 lg:w-2 lg:h-2 rounded-full bg-white" />}
                                            </span>
                                            <span className={`text-xs lg:text-sm ${
                                                isModon || isVaccine
                                                    ? 'text-green-600 dark:text-green-400 font-medium'
                                                    : 'text-gray-500 dark:text-gray-400'
                                            }`}>
                                                모돈 작업설정
                                            </span>
                                        </label>
                                    </div>
                                </div>

                                {/* 농장 기본값 표시 */}
                                {!isModon && farmDefaults.length > 0 && (
                                    <div className="px-4 pb-3 pt-0">
                                        <div className="bg-white dark:bg-gray-800 rounded-md border border-blue-100 dark:border-blue-800 overflow-hidden">
                                            {farmDefaults.map((defaultItem, idx) => (
                                                <div
                                                    key={idx}
                                                    className={`flex items-center justify-between px-3 py-1.5 lg:py-2 text-xs lg:text-sm ${
                                                        idx < farmDefaults.length - 1 ? 'border-b border-gray-100 dark:border-gray-700' : ''
                                                    }`}
                                                >
                                                    <span className="text-gray-600 dark:text-gray-400">
                                                        {defaultItem.targetGroup}
                                                        {defaultItem.settingName && <span className="text-gray-400 dark:text-gray-500 ml-1">({defaultItem.settingName})</span>}
                                                    </span>
                                                    <span className="font-medium text-blue-600 dark:text-blue-400">
                                                        {defaultItem.value}
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* 모돈 작업설정 표시 */}
                                {(isModon || isVaccine) && modonTasks.length > 0 && (
                                    <div className="px-4 pb-3 pt-0">
                                        <div className="bg-white dark:bg-gray-800 rounded-md border border-gray-200 dark:border-gray-600 overflow-hidden">
                                            <div className="grid grid-cols-[20px_2fr_2fr_40px] lg:grid-cols-[24px_2fr_2fr_50px] gap-2 px-3 py-1.5 lg:py-2 bg-gray-50 dark:bg-gray-700 text-xs lg:text-sm font-medium text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-600">
                                                <div></div>
                                                <div>작업명</div>
                                                <div>대상돈군</div>
                                                <div className="text-right">경과일</div>
                                            </div>
                                            {modonTasks.map((task, idx) => {
                                                const isSelected = selectedTasks.includes(task.seq);
                                                // 백신은 0개 허용이므로 마지막 하나도 해제 가능
                                                const isLastSelected = isSelected && selectedTasks.length === 1 && !isVaccine;
                                                const isDisabled = readOnly || isLastSelected;

                                                return (
                                                    <div
                                                        key={task.seq}
                                                        className={`grid grid-cols-[20px_2fr_2fr_40px] lg:grid-cols-[24px_2fr_2fr_50px] gap-2 px-3 py-1.5 lg:py-2 items-center transition-colors ${
                                                            readOnly ? 'cursor-default' : 'cursor-pointer'
                                                        } ${
                                                            isSelected
                                                                ? 'bg-green-50 dark:bg-green-900/20'
                                                                : readOnly ? '' : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'
                                                        } ${idx < modonTasks.length - 1 ? 'border-b border-gray-100 dark:border-gray-700' : ''}`}
                                                        onClick={() => !readOnly && !isLastSelected && handleModonTaskToggle(item.key, task.seq)}
                                                    >
                                                        <div>
                                                            <input
                                                                type="checkbox"
                                                                checked={isSelected}
                                                                onChange={() => {}}
                                                                disabled={isDisabled}
                                                                className={`w-3.5 h-3.5 lg:w-4 lg:h-4 rounded border-gray-300 dark:border-gray-600 text-green-500 focus:ring-green-500 pointer-events-none ${
                                                                    isDisabled ? 'cursor-not-allowed opacity-50' : ''
                                                                }`}
                                                            />
                                                        </div>
                                                        <div className={`text-xs lg:text-sm ${isSelected ? 'text-gray-900 dark:text-white font-medium' : 'text-gray-500 dark:text-gray-400'}`}>
                                                            {task.taskNm}
                                                        </div>
                                                        <div className={`text-xs lg:text-sm ${isSelected ? 'text-gray-700 dark:text-gray-300' : 'text-gray-400 dark:text-gray-500'}`}>
                                                            {task.targetGroup}
                                                        </div>
                                                        <div className={`text-xs lg:text-sm text-right ${isSelected ? 'text-gray-700 dark:text-gray-300' : 'text-gray-400 dark:text-gray-500'}`}>
                                                            {task.elapsedDays}
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                        <div className="mt-2 text-xs lg:text-sm text-gray-500 dark:text-gray-400">
                                            {selectedTasks.length}개 작업 선택됨
                                            {/* 백신은 0개 허용이므로 최소 1개 필수 경고 표시 안함 */}
                                            {selectedTasks.length === 1 && !isVaccine && (
                                                <span className="text-amber-600 dark:text-amber-400 ml-2">(최소 1개 필수)</span>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}

                    {/* 출하 */}
                    {(() => {
                        const shipDays = farmConfigData?.farmConfig['140005']?.value || 180;
                        const weanPeriod = farmConfigData?.farmConfig['140003']?.value || 21;
                        const shipOffset = shipDays - weanPeriod;
                        return (
                            <div id="schedule-shipment" className="border rounded-lg border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-900/10">
                                <div className="flex items-center justify-between px-4 py-3">
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm lg:text-base font-medium text-gray-700 dark:text-gray-300">
                                            출하
                                        </span>
                                    </div>
                                    <span className="text-xs lg:text-sm text-blue-600 dark:text-blue-400 font-medium">
                                        농장 기본값
                                    </span>
                                </div>
                                <div className="px-4 pb-3 pt-0">
                                    <div className="bg-white dark:bg-gray-800 rounded-md border border-blue-100 dark:border-blue-800 overflow-hidden">
                                        <div className="flex items-center justify-between px-3 py-1.5 lg:py-2 text-xs lg:text-sm border-b border-gray-100 dark:border-gray-700">
                                            <span className="text-gray-600 dark:text-gray-400">기준출하일령</span>
                                            <span className="font-medium text-blue-600 dark:text-blue-400">{shipDays}일</span>
                                        </div>
                                        <div className="flex items-center justify-between px-3 py-1.5 lg:py-2 text-xs lg:text-sm border-b border-gray-100 dark:border-gray-700">
                                            <span className="text-gray-600 dark:text-gray-400">평균포유기간</span>
                                            <span className="font-medium text-blue-600 dark:text-blue-400">{weanPeriod}일</span>
                                        </div>
                                        <div className="flex items-center justify-between px-3 py-1.5 lg:py-2 text-xs lg:text-sm bg-blue-50 dark:bg-blue-900/30">
                                            <span className="text-gray-700 dark:text-gray-300 font-medium">산정 범위</span>
                                            <span className="font-medium text-blue-700 dark:text-blue-300">이유 후 {shipOffset}~{shipOffset + 6}일</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        );
                    })()}
                </div>

                {/* 저장 버튼 */}
                {showSaveButton && (
                    <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-700 flex items-center justify-end gap-3">
                        {message && (
                            <span className={`text-xs ${
                                message.type === 'success'
                                    ? 'text-green-600 dark:text-green-400'
                                    : 'text-red-600 dark:text-red-400'
                            }`}>
                                {message.text}
                            </span>
                        )}
                        <button
                            onClick={handleSave}
                            disabled={saving}
                            className={`px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors ${
                                saving ? 'opacity-50 cursor-not-allowed' : ''
                            }`}
                        >
                            {saving ? '저장 중...' : '저장'}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

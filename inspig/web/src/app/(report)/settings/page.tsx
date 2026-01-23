"use client";

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
    faCalendarWeek,
    faCalendarAlt,
    faCalendarCheck,
    faClock,
    faBell,
    faLock,
    faCheck,
    faSpinner
} from '@fortawesome/free-solid-svg-icons';
import { serviceApi, ServiceInfo } from '@/services/api';
import WeeklyScheduleSettings from '@/components/settings/WeeklyScheduleSettings';

// 동적 렌더링 강제 - RSC 캐시 불일치 방지
export const dynamic = 'force-dynamic';

// 탭 타입 정의
type TabKey = 'service' | 'weekly' | 'monthly' | 'quarterly';

// 탭 설정
const TABS: {
    key: TabKey;
    label: string;
    icon: typeof faBell;
    isOpen: boolean;
    openDate?: string;
}[] = [
        { key: 'service', label: '알림 스케줄', icon: faBell, isOpen: true },
        { key: 'weekly', label: '주간보고서', icon: faCalendarWeek, isOpen: true },
        { key: 'monthly', label: '월간보고서', icon: faCalendarAlt, isOpen: false, openDate: '2026-02-01' },
        { key: 'quarterly', label: '분기보고서', icon: faCalendarCheck, isOpen: false, openDate: '2026-04-01' },
    ];

// 스케줄 그룹별 시간 정보
const SCHEDULE_GROUPS = {
    AM7: { etl: '02:00', notification: '07:00', label: '오전 7시' },
    PM2: { etl: '12:00', notification: '14:00', label: '오후 2시' },
} as const;

type ScheduleGroupKey = keyof typeof SCHEDULE_GROUPS;

// 서비스 타입
type ServiceKey = 'weekly' | 'monthly' | 'quarterly';

// 서비스 오픈 일정
const SERVICE_SCHEDULE: Record<ServiceKey, {
    key: ServiceKey;
    name: string;
    icon: typeof faCalendarWeek;
    isOpen: boolean;
    openDate: string | null;
    scheduleGroups: readonly ScheduleGroupKey[];
    scheduleField: 'scheduleGroupWeek' | 'scheduleGroupMonth' | 'scheduleGroupQuarter';
    scheduleLabel: string;
    description: string;
}> = {
    weekly: {
        key: 'weekly',
        name: '주간 보고서',
        icon: faCalendarWeek,
        isOpen: true,
        openDate: null,
        scheduleGroups: ['AM7', 'PM2'] as const,
        scheduleField: 'scheduleGroupWeek',
        scheduleLabel: '매주 월요일',
        description: '지난주(월~일) 농장 운영 현황을 분석한 주간 보고서',
    },
    monthly: {
        key: 'monthly',
        name: '월간 보고서',
        icon: faCalendarAlt,
        isOpen: false,
        openDate: '2026-02-01',
        scheduleGroups: ['AM7', 'PM2'] as const,
        scheduleField: 'scheduleGroupMonth',
        scheduleLabel: '매월 1일',
        description: '지난달 농장 운영 현황을 종합 분석한 월간 보고서',
    },
    quarterly: {
        key: 'quarterly',
        name: '분기 보고서',
        icon: faCalendarCheck,
        isOpen: false,
        openDate: '2026-04-01',
        scheduleGroups: ['AM7', 'PM2'] as const,
        scheduleField: 'scheduleGroupQuarter',
        scheduleLabel: '분기 첫째날',
        description: '분기별 농장 성과를 심층 분석한 분기 보고서',
    },
};

const formatOpenDate = (dateStr: string | null) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}년 ${month}월 ${day}일`;
};

function SettingsContent() {
    const searchParams = useSearchParams();
    const initialTab = (searchParams.get('tab') as TabKey) || 'service';

    const [activeTab, setActiveTab] = useState<TabKey>(initialTab);
    const [serviceInfo, setServiceInfo] = useState<ServiceInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState<ServiceKey | null>(null);
    const [selectedGroups, setSelectedGroups] = useState<Record<ServiceKey, ScheduleGroupKey>>({
        weekly: 'AM7',
        monthly: 'AM7',
        quarterly: 'AM7',
    });
    const [saveMessage, setSaveMessage] = useState<{ serviceKey: ServiceKey; type: 'success' | 'error'; text: string } | null>(null);

    // 서비스 정보 로드
    useEffect(() => {
        const loadServiceInfo = async () => {
            try {
                const info = await serviceApi.getService();
                setServiceInfo(info);
                if (info) {
                    setSelectedGroups({
                        weekly: (info.scheduleGroupWeek as ScheduleGroupKey) || 'AM7',
                        monthly: (info.scheduleGroupMonth as ScheduleGroupKey) || 'AM7',
                        quarterly: (info.scheduleGroupQuarter as ScheduleGroupKey) || 'AM7',
                    });
                }
            } catch (error) {
                console.error('서비스 정보 로드 실패:', error);
            } finally {
                setLoading(false);
            }
        };
        loadServiceInfo();
    }, []);

    // 탭 변경 핸들러
    const handleTabChange = (tabKey: TabKey) => {
        const tab = TABS.find(t => t.key === tabKey);
        if (tab?.isOpen) {
            setActiveTab(tabKey);
            // URL 파라미터 업데이트 (브라우저 히스토리에 추가하지 않음)
            const url = new URL(window.location.href);
            url.searchParams.set('tab', tabKey);
            window.history.replaceState({}, '', url.toString());
        }
    };

    // 스케줄 그룹 저장
    const handleSaveScheduleGroup = async (serviceKey: ServiceKey) => {
        if (!serviceInfo || saving) return;

        // 확인 메시지
        const confirmed = window.confirm(
            '변경된 설정은 차주 보고서 발송부터 반영됩니다.\n계속하시겠습니까?'
        );
        if (!confirmed) return;

        setSaving(serviceKey);
        setSaveMessage(null);

        try {
            // 현재는 weekly만 저장 가능 (monthly, quarterly는 추후 추가)
            if (serviceKey === 'weekly') {
                await serviceApi.updateScheduleGroup(selectedGroups[serviceKey]);
                setServiceInfo({ ...serviceInfo, scheduleGroupWeek: selectedGroups[serviceKey] });
            }
            setSaveMessage({ serviceKey, type: 'success', text: '저장되었습니다.' });
            setTimeout(() => setSaveMessage(null), 3000);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : '저장에 실패했습니다.';
            setSaveMessage({ serviceKey, type: 'error', text: message });
        } finally {
            setSaving(null);
        }
    };

    const isServiceValid = serviceInfo !== null;

    // 해당 서비스의 현재 저장된 값과 선택된 값이 다른지 확인
    const hasChanges = (serviceKey: ServiceKey): boolean => {
        if (!serviceInfo) return false;
        const field = SERVICE_SCHEDULE[serviceKey].scheduleField;
        const savedValue = serviceInfo[field] || 'AM7';
        return savedValue !== selectedGroups[serviceKey];
    };

    // 서비스 설정 탭 렌더링
    const renderServiceTab = () => (
        <div className="space-y-4">
            {Object.entries(SERVICE_SCHEDULE).map(([key, service]) => {
                const serviceKey = key as ServiceKey;
                const currentGroupKey = selectedGroups[serviceKey];
                const currentGroupInfo = SCHEDULE_GROUPS[currentGroupKey];
                const canEdit = service.isOpen && isServiceValid;
                const isCurrentSaving = saving === serviceKey;
                const currentSaveMessage = saveMessage?.serviceKey === serviceKey ? saveMessage : null;

                return (
                    <div
                        key={key}
                        className={`bg-white dark:bg-gray-800 rounded-xl shadow-sm border ${service.isOpen
                            ? 'border-gray-200 dark:border-gray-700'
                            : 'border-gray-100 dark:border-gray-800 opacity-75'
                            }`}
                    >
                        {/* 카드 헤더 */}
                        <div className={`px-5 py-4 border-b ${service.isOpen
                            ? 'border-gray-100 dark:border-gray-700'
                            : 'border-gray-50 dark:border-gray-800'
                            }`}>
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${service.isOpen
                                        ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                                        : 'bg-gray-100 dark:bg-gray-700 text-gray-400'
                                        }`}>
                                        <FontAwesomeIcon
                                            icon={service.isOpen ? service.icon : faLock}
                                            className="text-lg"
                                        />
                                    </div>
                                    <div>
                                        <h2 className="font-semibold text-gray-900 dark:text-white">
                                            {service.name}
                                        </h2>
                                        <p className="text-xs text-gray-500 dark:text-gray-400">
                                            {service.description}
                                        </p>
                                    </div>
                                </div>
                                {service.isOpen ? (
                                    <span className="px-2.5 py-1 text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 rounded-full shrink-0 text-center whitespace-nowrap">
                                        서비스 중
                                    </span>
                                ) : (
                                    <span className="px-2.5 py-1 text-xs font-medium bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400 rounded-full shrink-0 text-center whitespace-nowrap">
                                        준비 중
                                    </span>
                                )}
                            </div>
                        </div>

                        {/* 카드 바디 */}
                        <div className="px-5 py-4">
                            {/* 알림톡 발송 시간 설정 */}
                            {service.isOpen && (
                                <div className="mb-4">
                                    <div className="flex items-center gap-2 mb-3">
                                        <FontAwesomeIcon
                                            icon={faBell}
                                            className="text-green-600 dark:text-green-400 text-sm"
                                        />
                                        <span className="text-sm font-medium text-gray-900 dark:text-white">
                                            알림톡 발송 시간 설정
                                        </span>
                                        {loading && (
                                            <FontAwesomeIcon icon={faSpinner} className="text-gray-400 animate-spin text-sm ml-2" />
                                        )}
                                    </div>

                                    {loading ? (
                                        <div className="flex items-center justify-center py-4">
                                            <FontAwesomeIcon icon={faSpinner} className="text-gray-400 animate-spin" />
                                        </div>
                                    ) : !isServiceValid ? (
                                        <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3 text-center">
                                            <p className="text-sm text-gray-500 dark:text-gray-400">
                                                인사이트피그 서비스가 등록되어 있지 않습니다.
                                            </p>
                                            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                                                서비스 등록 후 알림톡 발송 시간을 설정할 수 있습니다.
                                            </p>
                                        </div>
                                    ) : (
                                        <>
                                            {/* 시간대 선택 라디오 버튼 */}
                                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
                                                {(Object.entries(SCHEDULE_GROUPS) as [ScheduleGroupKey, typeof SCHEDULE_GROUPS[ScheduleGroupKey]][]).map(([groupKey, group]) => (
                                                    <label
                                                        key={groupKey}
                                                        className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-all ${currentGroupKey === groupKey
                                                            ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                                                            : 'border-gray-200 dark:border-gray-600 hover:border-gray-300 dark:hover:border-gray-500'
                                                            }`}
                                                    >
                                                        <input
                                                            type="radio"
                                                            name={`scheduleGroup-${serviceKey}`}
                                                            value={groupKey}
                                                            checked={currentGroupKey === groupKey}
                                                            onChange={() => setSelectedGroups(prev => ({ ...prev, [serviceKey]: groupKey }))}
                                                            className="sr-only"
                                                        />
                                                        <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${currentGroupKey === groupKey
                                                            ? 'border-blue-500 bg-blue-500'
                                                            : 'border-gray-300 dark:border-gray-500'
                                                            }`}>
                                                            {currentGroupKey === groupKey && (
                                                                <FontAwesomeIcon icon={faCheck} className="text-white text-[8px]" />
                                                            )}
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <p className={`text-sm font-medium ${currentGroupKey === groupKey
                                                                ? 'text-blue-700 dark:text-blue-300'
                                                                : 'text-gray-900 dark:text-white'
                                                                }`}>
                                                                {group.label}
                                                            </p>
                                                            <p className="text-xs text-gray-500 dark:text-gray-400">
                                                                ETL {group.etl} / 알림톡 {group.notification}
                                                            </p>
                                                        </div>
                                                    </label>
                                                ))}
                                            </div>

                                            {/* 저장 버튼 및 메시지 */}
                                            <div className="flex items-center gap-3">
                                                <button
                                                    id={`ibs01-btn-save-schedule-${serviceKey}`}
                                                    onClick={() => handleSaveScheduleGroup(serviceKey)}
                                                    disabled={!hasChanges(serviceKey) || isCurrentSaving}
                                                    className={`px-3 py-1.5 rounded-lg font-medium text-xs transition-all ${hasChanges(serviceKey) && !isCurrentSaving
                                                        ? 'bg-blue-600 text-white hover:bg-blue-700'
                                                        : 'bg-gray-200 text-gray-400 dark:bg-gray-600 dark:text-gray-500 cursor-not-allowed'
                                                        }`}
                                                >
                                                    {isCurrentSaving ? (
                                                        <>
                                                            <FontAwesomeIcon icon={faSpinner} className="animate-spin mr-1" />
                                                            저장 중...
                                                        </>
                                                    ) : '저장'}
                                                </button>
                                                {currentSaveMessage && (
                                                    <span className={`text-xs ${currentSaveMessage.type === 'success'
                                                        ? 'text-green-600 dark:text-green-400'
                                                        : 'text-red-600 dark:text-red-400'
                                                        }`}>
                                                        {currentSaveMessage.text}
                                                    </span>
                                                )}
                                            </div>
                                        </>
                                    )}
                                </div>
                            )}

                            {/* 스케줄 정보 (separator) */}
                            {service.isOpen && isServiceValid && (
                                <div className="border-t border-gray-100 dark:border-gray-700 pt-4 mt-4" />
                            )}

                            {/* 데이터 생성/알림 발송 시간 정보 */}
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                {/* 데이터 생성 시간 */}
                                <div className="flex items-start gap-3">
                                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${service.isOpen
                                        ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400'
                                        : 'bg-gray-50 dark:bg-gray-700/50 text-gray-400'
                                        }`}>
                                        <FontAwesomeIcon icon={faClock} className="text-sm" />
                                    </div>
                                    <div>
                                        <p className="text-xs text-gray-500 dark:text-gray-400 mb-0.5">
                                            데이터 생성
                                        </p>
                                        <p className={`text-sm font-medium ${service.isOpen
                                            ? 'text-gray-900 dark:text-white'
                                            : 'text-gray-400 dark:text-gray-500'
                                            }`}>
                                            {service.isOpen && canEdit
                                                ? `${service.scheduleLabel} ${currentGroupInfo.etl}`
                                                : `${service.scheduleLabel} ${SCHEDULE_GROUPS.AM7.etl} / ${SCHEDULE_GROUPS.PM2.etl}${!service.isOpen ? ' (예정)' : ''}`
                                            }
                                        </p>
                                    </div>
                                </div>

                                {/* 알림 발송 시간 */}
                                <div className="flex items-start gap-3">
                                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${service.isOpen
                                        ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400'
                                        : 'bg-gray-50 dark:bg-gray-700/50 text-gray-400'
                                        }`}>
                                        <FontAwesomeIcon icon={faBell} className="text-sm" />
                                    </div>
                                    <div>
                                        <p className="text-xs text-gray-500 dark:text-gray-400 mb-0.5">
                                            알림톡 발송
                                        </p>
                                        <p className={`text-sm font-medium ${service.isOpen
                                            ? 'text-gray-900 dark:text-white'
                                            : 'text-gray-400 dark:text-gray-500'
                                            }`}>
                                            {service.isOpen && canEdit
                                                ? `${service.scheduleLabel} ${currentGroupInfo.notification}`
                                                : `${service.scheduleLabel} ${SCHEDULE_GROUPS.AM7.notification} / ${SCHEDULE_GROUPS.PM2.notification}${!service.isOpen ? ' (예정)' : ''}`
                                            }
                                        </p>
                                    </div>
                                </div>
                            </div>

                            {/* 오픈 예정일 (준비 중인 서비스) */}
                            {!service.isOpen && service.openDate && (
                                <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-700">
                                    <p className="text-xs text-gray-500 dark:text-gray-400">
                                        오픈 예정일: <span className="text-blue-600 dark:text-blue-400 font-medium">{formatOpenDate(service.openDate)}</span>
                                    </p>
                                </div>
                            )}
                        </div>
                    </div>
                );
            })}

            {/* 안내 문구 */}
            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-4 text-sm text-blue-700 dark:text-blue-300">
                <p className="font-medium mb-1">알림톡 수신 안내</p>
                <p className="text-blue-600 dark:text-blue-400 text-xs break-keep">
                    알림톡은 피그플랜에 가입하신 휴대폰 번호로 발송됩니다.
                    수신 번호 변경은 피그플랜에서 직접 수정하시거나 관리자에게 문의해 주세요.
                </p>
                <p className="text-blue-600 dark:text-blue-400 text-xs break-keep mt-1">
                    * 알림톡 발송 시간은 카카오 서비스 상황에 따라 지연될 수 있습니다.
                </p>
            </div>
        </div>
    );

    // 농장번호 (serviceInfo에서 가져옴)
    const farmNo = serviceInfo?.farmNo;

    // 주간보고서 설정 탭 렌더링
    const renderWeeklyTab = () => (
        <div className="space-y-4">
            {/* 금주 작업예정 산정 방식 설정 */}
            <div id="section-weekly-schedule" className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700">
                <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700">
                    <h2 className="font-semibold text-gray-900 dark:text-white">
                        금주 작업예정 산정 방식
                    </h2>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 space-y-0.5">
                        <span className="block">• 모돈 작업설정 선택 시 최소 1개 이상 선택해야 합니다.</span>
                        <span className="block">• 변경된 설정은 차주 보고서부터 적용됩니다.</span>
                    </p>
                    <div className="mt-2 p-2 bg-gray-50 dark:bg-gray-700/50 rounded text-xs text-gray-600 dark:text-gray-400 space-y-1.5">
                        <div>
                            <p><span className="font-medium text-blue-600 dark:text-blue-400">농장 기본값</span>: 기준 작업일 + 경과일 (예: 교배일+115일)</p>
                            <p className="text-gray-400">※ 생성일 이후 PIGPLAN 작업시 영향없음</p>
                        </div>
                        <div>
                            <p><span className="font-medium text-green-600 dark:text-green-400">모돈 작업설정</span>: 마지막 작업일 + 경과일</p>
                            <p className="text-gray-400">(번식돈관리 &gt; 모돈 작업/예정보고서 &gt; 작업예정돈)</p>
                            <p className="text-gray-400">※ 생성 후 PIGPLAN 작업시 보고서와 상이할 수 있음</p>
                        </div>
                    </div>
                </div>
                {farmNo ? (
                    <WeeklyScheduleSettings farmNo={farmNo} showSaveButton={true} />
                ) : (
                    <div className="px-4 py-8 text-center text-gray-500 dark:text-gray-400 text-sm">
                        농장 정보를 불러오는 중...
                    </div>
                )}
            </div>

            {/* 안내 문구 */}
            <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl p-4 text-sm text-amber-700 dark:text-amber-300">
                <p className="font-medium mb-1">설정값 확인 경로</p>
                <ul className="text-amber-600 dark:text-amber-400 text-xs space-y-1">
                    <li><strong>농장 기본값:</strong> 피그플랜 &gt; 농장 정보관리 &gt; 농장 기본값 설정</li>
                    <li><strong>모돈 작업설정:</strong> 피그플랜 &gt; 농장 정보관리 &gt; 모돈 작업설정</li>
                </ul>
            </div>
        </div>
    );

    // 준비 중 탭 렌더링
    const renderComingSoonTab = (tabKey: TabKey) => {
        const tab = TABS.find(t => t.key === tabKey);
        return (
            <div className="space-y-4">
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700">
                    <div className="px-5 py-12 text-center">
                        <div className="text-gray-400 dark:text-gray-500">
                            <FontAwesomeIcon icon={faLock} className="text-4xl mb-3" />
                            <p className="text-sm font-medium mb-1">{tab?.label} 설정</p>
                            <p className="text-xs">서비스 오픈 후 이용 가능합니다.</p>
                            {tab?.openDate && (
                                <p className="text-xs text-blue-500 mt-2">
                                    오픈 예정일: {formatOpenDate(tab.openDate)}
                                </p>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    // 탭 콘텐츠 렌더링
    const renderTabContent = () => {
        switch (activeTab) {
            case 'service':
                return renderServiceTab();
            case 'weekly':
                return renderWeeklyTab();
            case 'monthly':
            case 'quarterly':
                return renderComingSoonTab(activeTab);
            default:
                return renderServiceTab();
        }
    };

    return (
        <div className="p-4 sm:p-6 space-y-6 max-w-5xl mx-auto">
            {/* 페이지 헤더 */}
            <div className="mb-2">
                <h1 className="text-2xl font-bold text-gray-900 dark:text-white">환경설정</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                    서비스 및 보고서 설정을 관리합니다.
                </p>
            </div>

            {/* 탭 네비게이션 */}
            <div className="border-b border-gray-200 dark:border-gray-700">
                <nav className="flex space-x-1 -mb-px overflow-x-auto" aria-label="Tabs">
                    {TABS.map((tab) => {
                        const isActive = activeTab === tab.key;
                        const isDisabled = !tab.isOpen;

                        return (
                            <button
                                key={tab.key}
                                onClick={() => handleTabChange(tab.key)}
                                disabled={isDisabled}
                                className={`
                                    flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors
                                    ${isActive
                                        ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                                        : isDisabled
                                            ? 'border-transparent text-gray-300 dark:text-gray-600 cursor-not-allowed'
                                            : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300'
                                    }
                                `}
                            >
                                <FontAwesomeIcon
                                    icon={isDisabled ? faLock : tab.icon}
                                    className={`text-sm ${isDisabled ? 'text-gray-300 dark:text-gray-600' : ''}`}
                                />
                                <span>{tab.label}</span>
                                {isDisabled && (
                                    <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 rounded">
                                        준비중
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </nav>
            </div>

            {/* 탭 콘텐츠 */}
            <div className="mt-4">
                {renderTabContent()}
            </div>
        </div>
    );
}

export default function SettingsPage() {
    return (
        <Suspense fallback={<div className="p-4 sm:p-6 space-y-6 max-w-5xl mx-auto">로딩 중...</div>}>
            <SettingsContent />
        </Suspense>
    );
}

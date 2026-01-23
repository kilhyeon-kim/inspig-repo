"use client";

import React, { useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Image from 'next/image';
import { useAuth } from '@/contexts/AuthContext';

// Hard navigation 함수 - Next.js 클라이언트 라우터 우회
// 이중화 서버 환경에서 RSC 상태 불일치 문제 방지
const navigateTo = (path: string) => {
  window.location.href = path;
};

// 동적 렌더링 강제 - RSC 캐시 불일치 방지
export const dynamic = 'force-dynamic';


const TEST_ACCOUNTS = [
 { label: '-- 테스트 계정 선택 --', id: '', pw: '' },
 { label: '이지팜농장', id: 'test001', pw: '12341234' },  // 1387
 { label: 'jjin', id: 'jjin', pw: '1122' },  // 1387
 { label: '한솔축산', id: 'dcd192', pw: 'ddr1495' },  // 2560
 { label: '서해농장', id: 'west001', pw: 'tjgoshdwkd1' }, // 848
 { label: '한탄강스마트팜', id: 'bethel2007sm', pw: 'chy67110' }, // 4221
 { label: '민근농장/장일농장', id: 'centauru1', pw: 'kwak88176' }, //  4448
];

function LoginContent() {
  const searchParams = useSearchParams();
  const { login, isLoading } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState('');

  // 개발 모드: ?dev=1 쿼리 파라미터가 있을 때만 테스트 계정 UI 표시
  const isDevMode = searchParams.get('dev') === '1';

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);

    const result = await login(username, password);

    if (result.success) {
      navigateTo('/weekly');
    } else {
      setError(result.error || '로그인에 실패했습니다.');
    }

    setIsSubmitting(false);
  };

  // 테스트 계정 선택 시 자동 로그인
  const handleTestAccountSelect = async (value: string) => {
    setSelectedAccount(value);
    if (!value) return;

    const account = TEST_ACCOUNTS.find(acc => acc.id === value);
    if (!account || !account.id) return;

    setError('');
    setIsSubmitting(true);

    const result = await login(account.id, account.pw);

    if (result.success) {
      navigateTo('/weekly');
    } else {
      setError(result.error || '로그인에 실패했습니다.');
      setSelectedAccount('');
    }

    setIsSubmitting(false);
  };

  // 로딩 중이면 로딩 표시
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <div className="text-gray-400">로딩 중...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-900 p-4">
      {/* CI 로고 및 타이틀 - 카드 바깥 */}
      <div className="text-center mb-8">
        <div className="flex justify-center mb-4">
          <Image
            src="/images/insight_ci.png"
            alt="인사이트피그"
            width={200}
            height={60}
            className="brightness-0 invert"
          />
        </div>
        <h1 className="text-2xl font-bold text-white">인사이트피그플랜</h1>
        <p className="text-gray-400 mt-2">스마트 양돈 관리 시스템</p>
      </div>

      {/* 로그인 카드 */}
      <div className="bg-gray-800 p-8 rounded-xl shadow-2xl w-full max-w-md border border-gray-700">
        {error && (
          <div className="mb-4 p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm break-keep">
            {error}
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-5">
          {/* 테스트 계정 콤보박스 - ?dev=1 파라미터가 있을 때만 표시 */}
          {isDevMode && (
            <>
              <div>
                <label htmlFor="testAccount" className="block text-sm font-medium text-yellow-400 mb-2">
                  테스트 계정 (선택 시 자동 로그인)
                </label>
                <select
                  id="testAccount"
                  value={selectedAccount}
                  onChange={(e) => handleTestAccountSelect(e.target.value)}
                  disabled={isSubmitting}
                  className="w-full px-4 py-3 bg-gray-700 border border-yellow-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-yellow-500 focus:border-transparent cursor-pointer"
                >
                  {TEST_ACCOUNTS.map((account) => (
                    <option key={account.id || 'default'} value={account.id}>
                      {account.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="relative flex items-center">
                <div className="flex-grow border-t border-gray-600"></div>
                <span className="flex-shrink mx-4 text-gray-500 text-sm">또는 직접 입력</span>
                <div className="flex-grow border-t border-gray-600"></div>
              </div>
            </>
          )}

          <div>
            <label htmlFor="username" className="block text-sm font-medium text-gray-300 mb-2">
              아이디
            </label>
            <input
              id="username"
              type="text"
              required
              className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
              placeholder="아이디를 입력하세요"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={isSubmitting}
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-300 mb-2">
              비밀번호
            </label>
            <input
              id="password"
              type="password"
              required
              className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
              placeholder="비밀번호를 입력하세요"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={isSubmitting}
            />
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full py-3 px-4 rounded-lg text-gray-900 font-semibold bg-green-500 hover:bg-green-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? '로그인 중...' : '로그인'}
          </button>

          <p className="text-center text-gray-300 text-sm mt-4">
            피그플랜(pigplan.io) 계정으로 로그인 하십시요
          </p>
        </form>
      </div>

      {/* 푸터 - 카드 바깥 */}
      <div className="mt-8 text-center space-y-1 max-w-md px-4">
        <p className="text-gray-400 text-sm">(콜센터)TEL : 031-421-3414</p>
        <p className="text-gray-500 text-xs leading-relaxed">
          본 사이트의 모든 콘텐츠는 저작권법의 보호를 받습니다.<br />
          무단전재, 복사, 배포 등을 금합니다.
        </p>
        <p className="text-gray-500 text-xs">copyright © wiselake. All rights reserved.</p>
      </div>
    </div>
  );
}

// 로딩 폴백 컴포넌트
function LoginFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900">
      <div className="text-gray-400">로딩 중...</div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginContent />
    </Suspense>
  );
}

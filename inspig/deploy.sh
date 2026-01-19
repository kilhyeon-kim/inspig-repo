#!/bin/bash
# InsightPig 이중화 서버 배포 스크립트
# 사용법:
#   ./deploy.sh          - 커밋되지 않은 변경 파일만 배포
#   ./deploy.sh -last    - 마지막 커밋 변경 파일 배포
#   ./deploy.sh -last 3  - 최근 3개 커밋 변경 파일 배포
#   ./deploy.sh -all     - 전체 프로젝트 배포

# 스크립트가 있는 디렉토리로 이동
cd "$(dirname "$0")"
PROJECT_DIR=$(pwd)

KEY_PATH="E:/ssh key/sshkey/aws/ProdPigplanKey.pem"
REMOTE_PATH="/data/insightPig"
SERVERS=("10.4.38.10" "10.4.99.10")
USER="pigplan"

echo "프로젝트 경로: $PROJECT_DIR"

# 배포 제외 패턴
EXCLUDE_PATTERNS=(
    ".vscode" ".git" ".gitignore" ".claude" ".agent"
    ".env.example" "node_modules" "docs" "sample"
    "References" "deploy.sh" "start_pig.sh" "nul" "*.md"
)

# 제외 패턴을 rsync 형식으로 변환
EXCLUDES=""
for pattern in "${EXCLUDE_PATTERNS[@]}"; do
    EXCLUDES="$EXCLUDES --exclude=$pattern"
done

echo "========================================="
echo "  InsightPig 이중화 서버 배포"
echo "========================================="

# 파일 배포 함수
deploy_files() {
    local FILES="$1"

    for SERVER in "${SERVERS[@]}"; do
        echo ">>> 배포 중: $SERVER"
        echo "-----------------------------------------"

        for file in $FILES; do
            # 디렉토리 구조 유지하며 업로드
            dir=$(dirname "$file")
            ssh -i "$KEY_PATH" ${USER}@${SERVER} "mkdir -p ${REMOTE_PATH}/${dir}" 2>/dev/null
            scp -i "$KEY_PATH" "$file" ${USER}@${SERVER}:${REMOTE_PATH}/${file}

            if [ $? -eq 0 ]; then
                echo "  [OK] $file"
            else
                echo "  [FAIL] $file"
            fi
        done
        echo ""
    done
}

# 파일 필터링 함수 (제외 패턴 적용)
filter_files() {
    local INPUT_FILES="$1"
    local RESULT=""

    for file in $INPUT_FILES; do
        skip=false
        for pattern in "${EXCLUDE_PATTERNS[@]}"; do
            if [[ "$file" == *"$pattern"* ]] || [[ "$file" == $pattern ]]; then
                skip=true
                break
            fi
        done
        if [ "$skip" = false ] && [ -f "$file" ]; then
            RESULT="$RESULT $file"
        fi
    done
    echo "$RESULT"
}

# 모드 확인
if [ "$1" == "-all" ]; then
    echo ">>> 모드: 전체 배포 (scp)"
    echo ""

    for SERVER in "${SERVERS[@]}"; do
        echo ">>> 배포 중: $SERVER"
        echo "-----------------------------------------"

        # docker-compose.yml 업로드
        echo "  업로드: docker-compose.yml"
        scp -i "$KEY_PATH" docker-compose.yml ${USER}@${SERVER}:${REMOTE_PATH}/

        # nginx 디렉토리 업로드 (작은 파일들)
        echo "  업로드: nginx/"
        scp -i "$KEY_PATH" -r nginx ${USER}@${SERVER}:${REMOTE_PATH}/

        # api 디렉토리 업로드 (node_modules 제외 - tar 사용)
        echo "  업로드: api/ (node_modules 제외)"
        tar --exclude='node_modules' --exclude='.git' --exclude='docs' --exclude='*.md' -cf - api | ssh -i "$KEY_PATH" ${USER}@${SERVER} "cd ${REMOTE_PATH} && tar -xf -"

        # web 디렉토리 업로드 (node_modules 제외 - tar 사용)
        echo "  업로드: web/ (node_modules 제외)"
        tar --exclude='node_modules' --exclude='.git' --exclude='docs' --exclude='*.md' -cf - web | ssh -i "$KEY_PATH" ${USER}@${SERVER} "cd ${REMOTE_PATH} && tar -xf -"

        if [ $? -eq 0 ]; then
            echo "[OK] $SERVER 배포 완료"
        else
            echo "[FAIL] $SERVER 배포 실패"
        fi
        echo ""
    done

elif [ "$1" == "-last" ]; then
    # 커밋 개수 (기본값: 1)
    COMMIT_COUNT=${2:-1}
    echo ">>> 모드: 최근 ${COMMIT_COUNT}개 커밋 변경 파일 배포"
    echo ""

    # 최근 N개 커밋에서 변경된 파일 목록 (모노레포 구조로 inspig/ 접두사 제거)
    ALL_FILES=$(git diff --name-only HEAD~${COMMIT_COUNT} HEAD 2>/dev/null | sed 's|^inspig/||' | sort -u)

    # 제외 패턴 필터링
    DEPLOY_FILES=$(filter_files "$ALL_FILES")

    if [ -z "$DEPLOY_FILES" ]; then
        echo "배포 대상 파일이 없습니다."
        exit 0
    fi

    echo "배포 대상 파일:"
    for file in $DEPLOY_FILES; do
        echo "  - $file"
    done
    echo ""

    deploy_files "$DEPLOY_FILES"

else
    echo ">>> 모드: 변경 파일만 배포 (커밋되지 않은 파일)"
    echo ""

    # Git 변경 파일 목록 (staged + modified + untracked) - 모노레포 구조로 inspig/ 접두사 제거
    CHANGED_FILES=$(git diff --name-only HEAD 2>/dev/null | sed 's|^inspig/||')
    STAGED_FILES=$(git diff --cached --name-only 2>/dev/null | sed 's|^inspig/||')
    UNTRACKED_FILES=$(git ls-files --others --exclude-standard 2>/dev/null | sed 's|^inspig/||')

    # 합치고 중복 제거
    ALL_FILES=$(echo -e "$CHANGED_FILES\n$STAGED_FILES\n$UNTRACKED_FILES" | sort -u | grep -v '^$')

    # 제외 패턴 필터링
    DEPLOY_FILES=$(filter_files "$ALL_FILES")

    if [ -z "$DEPLOY_FILES" ]; then
        echo "변경된 배포 대상 파일이 없습니다."
        echo ""
        echo "TIP: 커밋된 파일을 배포하려면:"
        echo "  ./deploy.sh -last      # 마지막 1개 커밋"
        echo "  ./deploy.sh -last 3    # 최근 3개 커밋"
        exit 0
    fi

    echo "배포 대상 파일:"
    for file in $DEPLOY_FILES; do
        echo "  - $file"
    done
    echo ""

    deploy_files "$DEPLOY_FILES"
fi

echo "========================================="
echo "  배포 완료!"
echo "========================================="
echo ""
echo "Docker 빌드가 필요하면 각 서버에서 실행:"
echo "  cd $REMOTE_PATH && docker-compose up -d --build"

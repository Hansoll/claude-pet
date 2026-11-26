#!/bin/bash
# 맥용 실행 파일. 더블클릭하면 클로드 펫을 띄운다.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js가 설치되어 있지 않습니다. https://nodejs.org 에서 설치한 뒤 다시 실행하세요."
  read -r -p "Enter 키를 누르면 닫힙니다. "
  exit 1
fi
node launch.js "$@"
status=$?
if [ "$status" -ne 0 ]; then
  read -r -p "오류가 발생했습니다. Enter 키를 누르면 닫힙니다. "
fi
exit "$status"

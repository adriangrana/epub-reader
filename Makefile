.PHONY: build deploy restart redeploy status logs tts-status tts-logs tts-restart tunnel-logs

DEPLOY_DIR := C:/www/luma

build:
	npm run build

deploy: build
	powershell -NoProfile -ExecutionPolicy Bypass -File "./scripts/deploy.ps1" -DeployDir "$(DEPLOY_DIR)"

restart:
	runara restart luma

redeploy: deploy

status:
	runara info luma
	runara info luma-tts
	runara info luma-tunnel

logs:
	runara logs luma --lines 100

tts-status:
	runara info luma-tts

tts-logs:
	runara logs luma-tts --lines 100
	runara logs luma-tts --err --lines 100

tts-restart:
	runara restart luma-tts

tunnel-logs:
	runara logs luma-tunnel --lines 80
	runara logs luma-tunnel --err --lines 80

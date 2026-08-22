.PHONY: build deploy restart redeploy status logs tunnel-logs readers

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
	runara info luma-tunnel

logs:
	runara logs luma --lines 100

tunnel-logs:
	runara logs luma-tunnel --lines 80
	runara logs luma-tunnel --err --lines 80

readers:
	node scripts/book-readers.mjs "$(BOOK)" $(if $(DB),--db "$(DB)",)

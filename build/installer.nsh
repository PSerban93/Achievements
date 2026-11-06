# electron-builder inserts this hook after its process macros are defined and
# before the installer/uninstaller sections expand them.
!macro customHeader
  !include "${BUILD_RESOURCES_DIR}\installer-process-close.nsh"
!macroend

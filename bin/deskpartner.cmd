@echo off
rem deskpartner 命令行入口（Windows）
rem
rem 它只负责把参数转交给启动器；启动器会优先走常驻管道（通道 A），
rem 连不上再降级启动无头进程（通道 B）。两条路都在启动器里决定，
rem 这个包装脚本不做任何判断。
rem
rem 若想在任意目录直接敲 deskpartner，把本目录加入用户 PATH；
rem 不改 PATH 的话，用完整路径调用效果完全一样。

node "%~dp0..\out\cli\deskpartner.cjs" %*

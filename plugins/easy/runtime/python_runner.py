"""Execute agent-authored Python with file-access accounting and bounded local scope.
This is an integration boundary, not a hostile-code security sandbox.
"""
import sys,os,json,pathlib,runpy,time
for variable in ('OPENBLAS_NUM_THREADS','OMP_NUM_THREADS','MKL_NUM_THREADS'):
    os.environ[variable]='1'
root=pathlib.Path(os.environ['INDEPENDENT_CAD_JOB']).resolve()
deps=pathlib.Path(os.environ['PYTHONPATH']).resolve()
script=(root/sys.argv[1]).resolve()
assert script.is_relative_to(root/'agent') and script.suffix=='.py'
from workflow_stage import require_execution_stage
require_execution_stage(root)
sys.dont_write_bytecode=True
log=open(root/'.host/python-access.jsonl','a',encoding='utf-8')
reads=[root,pathlib.Path(sys.prefix).resolve(),deps,pathlib.Path('C:/Windows/Fonts').resolve()]
writes=[root/'agent',root/'artifacts']
def within(p,roots):
    try:r=pathlib.Path(os.fspath(p)).resolve()
    except (TypeError,ValueError):return False
    return any(r==b or r.is_relative_to(b) for b in roots)
def audit(event,args):
    if event=='open':
        name,mode,flags=args
        if isinstance(name,int):return
        writing=(isinstance(mode,str) and any(x in mode for x in 'wax+')) or bool((flags or 0)&(os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC|os.O_APPEND))
        allow=within(name,writes if writing else reads)
        log.write(json.dumps({'event':event,'path':str(name),'write':writing,'allowed':allow},ensure_ascii=False)+'\n');log.flush()
        if not allow:raise PermissionError('CAD task file boundary denied: '+str(name))
    elif event in ['os.listdir','os.scandir']:
        if args and args[0] is not None and not within(args[0],reads):raise PermissionError('Outside task/library directory')
    elif event in ['os.mkdir','os.remove','os.rmdir','os.chmod','os.utime']:
        if args and not within(args[0],writes):raise PermissionError('Write outside agent/artifacts')
    elif event in ['os.rename','os.replace','os.link','os.symlink']:
        if not within(args[0],writes) or not within(args[1],writes):raise PermissionError('Cross-boundary file operation')
    elif event in ['subprocess.Popen','os.system','os.startfile','socket.connect','socket.bind','winreg.OpenKey','winreg.CreateKey','winreg.SetValue']:
        raise PermissionError('Use provided CAD host tools instead of shell, registry or network')
sys.addaudithook(audit)
os.chdir(root)
sys.argv=[str(script)]
sys.path.insert(0,str(script.parent))  # Match `python agent/script.py` sibling imports.
runpy.run_path(str(script),run_name='__main__')
# Relay explicit user feedback to this already-running native DSH session.
# Host diagnostics are labeled separately from source evidence and DSH conclusions.
feedback=root/'.host/user-feedback.json'
if feedback.exists():
    message=json.loads(feedback.read_text(encoding='utf-8'))
    print('\nUSER FOLLOW-UP RECEIVED DURING THIS RUN:\n'+json.dumps(message,ensure_ascii=False))
task_kind=json.loads((root/'input.json').read_text(encoding='utf-8')).get('kind')
if task_kind=='cad_review':
    events=(root/'.host/events.jsonl').read_text(encoding='utf-8').splitlines()
    if sum(1 for line in events if '"type":"view"' in line)>=12:
        print('\nDSH review stage reminder: 这是验收任务，不是制图任务。候选保存在reference/，不需要生成artifacts/drawing.dxf。如果已经证实阻断交付的几何问题，请汇总已测证据并尽快cad_submit_review判needs_revision；尚未检查的类别标uncertain，不必继续反复裁标题栏。只有判pass才须8类全部有通过依据。不要重绘、无限裁图或把你可用工具核实的事推给人工/Codex。')
elif not (root/'artifacts/drawing.dxf').exists():
    events=(root/'.host/events.jsonl').read_text(encoding='utf-8').splitlines()
    views=sum(1 for line in events if '"type":"view"' in line)
    if views>=12:
        print('\nCAD workflow stage reminder: 已完成多轮看图。请将明确值、推导值和仍不清楚处分别写入尺寸记录，先完成可运行的整图第一版，再用预览和几何读回修订。不要为单个模糊标记无限反复裁切；不能确认的项明确保留，不得猜值。这个提示不提供任何零件尺寸。')

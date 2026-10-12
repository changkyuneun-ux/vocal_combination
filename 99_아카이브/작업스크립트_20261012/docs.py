import subprocess, os, re, sys, unicodedata as u, json
os.chdir(sys.argv[1]); apply='--apply' in sys.argv
N=lambda s:u.normalize('NFC',s)
git=lambda *a: subprocess.run(['git','-c','core.quotepath=off',*a],capture_output=True).stdout.decode()
# 옛→새 digest hex 쌍 (적합성 파일 위치 대응)
hexmap={}
for f in git('show','--name-only','--format=','615c2e9').splitlines():
    if '/conformance/' not in f or not f.endswith('.json'): continue
    old=re.findall(r'sha256:([0-9a-f]{64})',git('show',f'615c2e9^:{f}'))
    new=re.findall(r'sha256:([0-9a-f]{64})',git('show',f'615c2e9:{f}'))
    for o,n in zip(old,new):
        if o!=n: hexmap[o]=n
print('hex pairs',len(hexmap))
dob=re.compile(r'dobed[ou]pop(?!front)(?!-backoffice-prototype(?:_v2\.[3456])?\.html)')
skip={'node_modules','.git','99_아카이브','.superpowers','dist','04_구현_소스코드'}
manual={'./README.md','./00_프로젝트_개요/README.md','./00_프로젝트_개요/프로젝트_용어_및_아키텍처_맵.md'}
for dp,dns,fns in os.walk('.'):
    dns[:]=[d for d in dns if d not in skip and '히스토리' not in N(d)]
    for f in fns:
        p=os.path.join(dp,f)
        if not f.endswith(('.md','.json','.html')) or N(p) in manual: continue
        s=N(open(p,encoding='utf-8').read()); t=s
        t=t.replace('VCRL','MDRL').replace('Vcrl','Mdrl').replace('vcrl','mdrl')
        t=dob.sub('dobedubpop',t)
        for o,n in hexmap.items(): t=t.replace(o,n)
        if t!=s:
            print(sum(a!=b for a,b in zip(s.splitlines(),t.splitlines())),p)
            if apply: open(p,'w',encoding='utf-8').write(t)

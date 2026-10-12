import subprocess, os, re, sys, unicodedata as u
root = sys.argv[1]; os.chdir(root)
apply = '--apply' in sys.argv
N = lambda s: u.normalize('NFC', s)
out = subprocess.run(['git','-c','core.quotepath=off','diff','-M','--name-status','-z','97cf51e','HEAD'],capture_output=True).stdout.decode()
parts = out.split('\0'); i=0; mp={}
while i < len(parts)-1:
    st = parts[i]
    if st.startswith('R'):
        mp[N(parts[i+1])] = N(parts[i+2]); i+=3
    else: i+=2
# vcrl dir moved to mdrl in second commit: compose
fixed = {}
for o,n in mp.items():
    n2 = n.replace('04_구현_소스코드/vcrl/','04_구현_소스코드/mdrl/')
    fixed[o]=n2
prefixes = [('03_구현문서_코드/vcrl','04_구현_소스코드/mdrl'), ('03_구현문서_코드/','04_구현_소스코드/'),
            ('02_설계문서/VCRL_보컬조합권리언어/','02_MDRL_언어규격/02_구현계획/'),
            ('02_설계문서/권리정산인프라_20260927/','02_MDRL_언어규격/03_정산인프라_연계설계/'),
            ('02_설계문서/2차이용권리언어_마스터규격/','02_MDRL_언어규격/규격_히스토리/'),
            ('04_참고자료/','05_참고자료/')]
keys = sorted(fixed, key=len, reverse=True)
rx = re.compile('|'.join(re.escape(k) for k in keys))
dob = re.compile(r'dobedopop(?!front)(?!-backoffice-prototype(?:_v2\.[3456])?\.html)')
skip_dirs = {'node_modules','.git','99_아카이브','dist','.superpowers','test-results'}
changed = {}
for dp, dns, fns in os.walk('.'):
    dns[:] = [d for d in dns if d not in skip_dirs and '히스토리' not in N(d)]
    for f in fns:
        if not f.endswith(('.md','.json','.html','.ts','.tsx')) or f=='package-lock.json': continue
        p = os.path.join(dp,f)
        try: s = open(p,encoding='utf-8').read()
        except Exception: continue
        t = N(s)
        t = rx.sub(lambda m: fixed[m.group(0)], t)
        for a,b in prefixes: t = t.replace(a,b)
        if N(p) != './00_프로젝트_개요/프로젝트_용어_및_아키텍처_맵.md':
            t = dob.sub('dobedupop', t)
        if t != N(s):
            changed[p]=sum(1 for x,y in zip(t.splitlines(),N(s).splitlines()) if x!=y)
            if apply: open(p,'w',encoding='utf-8').write(t)
for p,c in sorted(changed.items()): print(c, p)

import math
SUL = {
 'low':  dict(a=-3.3717,b=25.8255,c=92.6594,d=-0.1624,e=0.0019),
 'mod':  dict(a=-2.8292,b=20.9482,c=77.6346,d=0.2228,e=-0.0004),
 'high': dict(a=-2.2893,b=19.4024,c=65.3577,d=0.6226,e=-0.0020),
}
def sul(q,t):
    p=SUL[q]; return p['c']/(math.pi*p['b']*(1+((t-p['a'])/p['b'])**2))+p['d']+p['e']*t
A,B,C=22.4056,77.6196,0.0464
def get(s): return B/(math.pi*A*(1+(s/A)**2))+C
def get_alt(s): return (0.0065*s*s+80.8887)/(0.1402*s*s+70.3892)
TH0=-2.8
def xc_mod(t): return get(t-TH0)
def rho(q,t):
    tc=max(-30,min(30,t)); return sul(q,tc)/sul('mod',tc)
def xc(q,t): return max(0.05, xc_mod(t)*rho(q,t))
print("Sullivan high min/km at -30,-15,0,15,30:",[round(1000/sul('high',t)/60,1) for t in (-30,-15,0,15,30)])
print("Sullivan mod min/km:",[round(1000/sul('mod',t)/60,1) for t in (-30,-15,0,15,30)])
print("Sullivan low min/km:",[round(1000/sul('low',t)/60,1) for t in (-30,-15,0,15,30)])
print("GET r(0), alt:",round(get(0),4),round(get_alt(0),4), "r(15)",round(get(15),3),round(get_alt(15),3),"r(45)",round(get(45),3),round(get_alt(45),3))
print("peak sul:",{q:max((sul(q,t/10),t/10) for t in range(-300,300)) for q in SUL})
print("xc mod peak", max((xc_mod(t/10),t/10) for t in range(-300,300)))
print("table theta: -45 -30 -15 -5 0 5 15 30 45")
for q in ('high','mod','low'):
    print('sul',q,[round(sul(q,t),3) for t in (-45,-30,-15,-5,0,5,15,30,45)])
for q in ('high','mod','low'):
    print('xc ',q,[round(xc(q,t),3) for t in (-45,-30,-15,-5,0,5,15,30,45)])
print('rho low',[round(rho('low',t),3) for t in (-30,-15,0,15,30)])
print('rho high',[round(rho('high',t),3) for t in (-30,-15,0,15,30)])
# cost encoding
def enc(M): return max(1,min(254,round(1+24*math.log2(M))))
def dec(v): return 2**((v-1)/24)
for M in (1,1.75,2.5,4,8,20,40,100):
    v=enc(M); print('M',M,'->',v,'->',round(dec(v),3))
# example: 1 km flat grass / timber / timber+TL
for M in (1,4,8):
    print('1km flat M',M,'times min (fast,typ,slow)',[round(1000*M/xc(q,0)/60,1) for q in ('high','mod','low')])
print('1km trail flat',[round(1000/sul(q,0)/60,1) for q in ('high','mod','low')])
print('1km trail +10deg',[round(1000/sul(q,10)/60,1) for q in ('high','mod','low')])
print('1km xc grass +10deg',[round(1000/xc(q,10)/60,1) for q in ('high','mod','low')])
print('1km xc grass -10deg',[round(1000/xc(q,-10)/60,1) for q in ('high','mod','low')])
print('vmax heuristic', max(sul('mod',t/100) for t in range(-4500,4500)), max(xc_mod(t/100) for t in range(-4500,4500)))
# stream crossing extra cost in timber
print('stream crossing extra s (typ) grass/timber/timberTL:', [round(30*(5*M-M)/xc('mod',0)) for M in (1,4,8)])

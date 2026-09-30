# Regenerates test-data/sealevel/ref.json: an independent reference for
# the plugin's Copernicus Marine sea-level point series (src/tides).
#
# Reads the geoChunked store of cmems_mod_glo_phy_anfc_merged-sl_PT1H-i_202411
# with xarray (remote, anonymous), checks that the fixture chunks in
# test-data/sealevel decode to exactly the same numbers (numcodecs), and
# computes for three coastal points: bilinear from the 4 surrounding
# cells with the coastal fill (a missing corner = IDW^2 mean of valid
# cells within 2 cells), the mean-sea-level offset mean(total - tide)
# over geo time chunk 9 (the chunk covering the last 60 days of run
# 2026100723), and 72 hourly values of tide, water level and surge from
# 2026-09-28T12Z.
#
# Fixture chunks: curl <geo store>/<var>/<key> for the keys printed below.
# Usage: SSL_CERT_FILE=$(python -c 'import certifi;print(certifi.where())') \
#        python tools/gen_sealevel_fixtures.py test-data/sealevel
# Needs xarray, zarr<3, numcodecs, fsspec, aiohttp.
# Independent reference for the plugin's sea-level point series: reads the
# geoChunked store with xarray (remote), bilinear with the coastal fill
# (IDW^2 over valid cells within 2 cells), MSL offset over geo time chunk 9.
import json, math, sys, numpy as np, xarray as xr, numcodecs
B='https://s3.waw3-1.cloudferro.com'; D='GLOBAL_ANALYSISFORECAST_PHY_001_024/cmems_mod_glo_phy_anfc_merged-sl_PT1H-i_202411'
ds=xr.open_zarr(f'{B}/mdl-arco-geo-015/arco/{D}/geoChunked.zarr', consolidated=True).isel(elevation=0)
NT=ds.sizes['time']; assert NT==35952, NT
lat0=float(ds.latitude[0]); dlat=float(ds.latitude[-1]-ds.latitude[0])/(ds.sizes['latitude']-1)
lon0=float(ds.longitude[0]); dlon=360.0/ds.sizes['longitude']
T0=35724; N=72   # 2026-09-28T12Z, 72 hours
M0, M1 = 9*3648, NT-1  # mean window: geo time chunk 9 (covers the last 60 days)
offs=[(dr,dc,1.0/(dr*dr+dc*dc)) for dr in range(-2,3) for dc in range(-2,3) if (dr or dc) and dr*dr+dc*dc<=4]
out={'run_time_count':NT,'t0_index':T0,'hours':N,'mean_window':[M0,M1],'points':[]}
fixdir=sys.argv[1]
for name,lat,lon in [('newport',41.52,-71.32),('portsmouth',50.84,-1.00),('sydney',-33.86,151.21)]:
  y=(lat-lat0)/dlat; x=((lon-lon0)%360)/dlon; fy=math.floor(y); fx=math.floor(x)
  r0,c0=fy-2,fx-2
  blk=ds[['ocean_tide','total_sea_level']].isel(latitude=slice(r0,r0+6),longitude=slice(c0,c0+6),time=slice(M0,NT)).load()
  # the fixture chunk decodes to the same numbers
  keys=sorted({f'9.0.{r//16}.{c//16}' for r in range(r0,r0+6) for c in range(c0,c0+6)})
  key=','.join(keys)
  for v in ('ocean_tide','total_sea_level'):
    sub=np.full((NT-M0,6,6),np.nan)
    for r in range(6):
      for c in range(6):
        R,C=r0+r,c0+c
        raw=np.frombuffer(numcodecs.Blosc().decode(open(f'{fixdir}/{v}_9.0.{R//16}.{C//16}','rb').read()),'<f4').reshape(3648,16,16)
        col=raw[:NT-M0,R%16,C%16].astype(np.float64); col[col==-9999.0]=np.nan; sub[:,r,c]=col
    a=blk[v].values.astype(np.float64)
    assert np.array_equal(np.isnan(a),np.isnan(sub)) and np.array_equal(np.nan_to_num(a),np.nan_to_num(sub)), (name,v)
  yl=y-r0; xl=x-c0; ry=math.floor(yl); cx=math.floor(xl); ty=yl-ry; tx=xl-cx
  def val(a):  # a: [t,6,6]
    res=np.zeros(a.shape[0]); fl=np.zeros(a.shape[0],bool)
    for w,rr,cc in [((1-tx)*(1-ty),ry,cx),(tx*(1-ty),ry,cx+1),((1-tx)*ty,ry+1,cx),(tx*ty,ry+1,cx+1)]:
      if w==0: continue
      v=a[:,rr,cc].copy(); miss=np.isnan(v)
      if miss.any():
        s=np.zeros(a.shape[0]); sw=np.zeros(a.shape[0])
        for dr,dc,ww in offs:
          r2,c2=rr+dr,cc+dc
          if 0<=r2<6 and 0<=c2<6:
            q=a[:,r2,c2]; ok=~np.isnan(q); s[ok]+=ww*q[ok]; sw[ok]+=ww
        fillv=np.where(sw>0,s/np.where(sw>0,sw,1),np.nan)
        v[miss]=fillv[miss]; fl|=miss
      res+=w*v
    return res,fl
  ot,f1=val(blk.ocean_tide.values.astype(np.float64)); ts,f2=val(blk.total_sea_level.values.astype(np.float64))
  ok=~np.isnan(ot)&~np.isnan(ts); off=float(np.mean(ts[ok]-ot[ok]))
  k=slice(T0-M0,T0-M0+N)
  tide=ot[k]; wl=ts[k]-off; surge=ts[k]-ot[k]-off
  out['points'].append({'name':name,'lat':lat,'lon':lon,'chunk':key,'offset':off,'samples':int(ok.sum()),
    'tide':tide.tolist(),'water_level':wl.tolist(),'surge':surge.tolist(),'extrapolated':(f1|f2)[k].astype(int).tolist()})
  print(name, key, 'offset', round(off,4), 'n', int(ok.sum()), 'extrap', bool((f1|f2)[k].any()), 'tide[0..3]', np.round(tide[:3],4))
json.dump(out, open(f'{fixdir}/ref.json','w'))

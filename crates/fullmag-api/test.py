import fullmag as fm

study = fm.study("contract-test")
study.engine("fdm")
body = study.geometry(fm.Box(200e-9, 20e-9, 6e-9), name="body")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.1
body.m = fm.texture.uniform(1, 0, 0)

# Stock Hummingbot dashboard + MY interface overlays baked in.
# Bind-mounting these files works locally but NOT on Coolify (it rewrites
# relative bind sources to empty persistent-storage dirs), so we COPY instead.
FROM hummingbot/dashboard:latest@sha256:fd28cc85ec0e8014a2cc7cf246acc932a41727dd4e6b5262d19c29a82400d80a

COPY dashboard-patches/components/backtesting.py /home/dashboard/frontend/components/backtesting.py
COPY dashboard-patches/pages/permissions.py     /home/dashboard/frontend/pages/permissions.py
COPY dashboard-patches/pages/config/scalping_breakout /home/dashboard/frontend/pages/config/scalping_breakout

# Stock Hummingbot dashboard + MY interface overlays baked in.
# Bind-mounting these files works locally but NOT on Coolify (it rewrites
# relative bind sources to empty persistent-storage dirs), so we COPY instead.
FROM hummingbot/dashboard:latest@sha256:fd28cc85ec0e8014a2cc7cf246acc932a41727dd4e6b5262d19c29a82400d80a

# my-trading: Auto-Tune needs Optuna for Bayesian (TPE) optimization.
RUN /opt/conda/envs/dashboard/bin/pip install --no-cache-dir optuna

COPY dashboard-patches/components/backtesting.py /home/dashboard/frontend/components/backtesting.py
COPY dashboard-patches/components/trade_viz.py   /home/dashboard/frontend/components/trade_viz.py
COPY dashboard-patches/components/auto_tune.py   /home/dashboard/frontend/components/auto_tune.py
COPY dashboard-patches/pages/permissions.py     /home/dashboard/frontend/pages/permissions.py
COPY dashboard-patches/pages/config/scalping_breakout /home/dashboard/frontend/pages/config/scalping_breakout
COPY dashboard-patches/pages/config/scalping_breakout_filtered /home/dashboard/frontend/pages/config/scalping_breakout_filtered
COPY dashboard-patches/pages/config/auto_tune /home/dashboard/frontend/pages/config/auto_tune

# my-trading: trade-analysis interface — new "Monitor Bots" page + color/WR on the Instances tab
COPY dashboard-patches/pages/orchestration/monitor_bots /home/dashboard/frontend/pages/orchestration/monitor_bots
COPY dashboard-patches/pages/orchestration/instances/app.py /home/dashboard/frontend/pages/orchestration/instances/app.py

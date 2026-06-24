import streamlit as st


def main_page():
    return [st.Page("frontend/pages/landing.py", title="Hummingbot Dashboard", icon="📊", url_path="landing")]


def public_pages():
    return {
        "Config Generator": [
            st.Page("frontend/pages/config/scalping_breakout/app.py", title="Scalping Breakout", icon="🚀", url_path="scalping_breakout"),
            st.Page("frontend/pages/config/auto_tune/app.py", title="Auto-Tune", icon="🎛️", url_path="auto_tune"),
        ],
        "Data": [
            st.Page("frontend/pages/data/download_candles/app.py", title="Download Candles", icon="💹", url_path="download_candles"),
        ],
        "Community Pages": [
            st.Page("frontend/pages/data/tvl_vs_mcap/app.py", title="TVL vs Market Cap", icon="🦉", url_path="tvl_vs_mcap"),
        ]
    }


def private_pages():
    return {
        "Bot Orchestration": [
            st.Page("frontend/pages/orchestration/instances/app.py", title="Instances", icon="🦅", url_path="instances"),
            st.Page("frontend/pages/orchestration/monitor_bots/app.py", title="Monitor Bots", icon="📈", url_path="monitor_bots"),
            st.Page("frontend/pages/orchestration/launch_bot_v2/app.py", title="Deploy V2", icon="🚀", url_path="launch_bot_v2"),
            st.Page("frontend/pages/orchestration/credentials/app.py", title="Credentials", icon="🔑", url_path="credentials"),
            st.Page("frontend/pages/orchestration/portfolio/app.py", title="Portfolio", icon="💰", url_path="portfolio"),
            st.Page("frontend/pages/orchestration/trading/app.py", title="Trading", icon="🪄", url_path="trading"),
            st.Page("frontend/pages/orchestration/archived_bots/app.py", title="Archived Bots", icon="🗃️", url_path="archived_bots"),
        ]
    }

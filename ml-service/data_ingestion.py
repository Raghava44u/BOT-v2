"""
Data Ingestion Layer
- Ticker-by-ticker sequential download (no parallel races)
- Max 3 retries per ticker with 2s delay
- Strict yfinance interval limits (5m/15m = 60 day chunks)
- Saves each ticker as /data/cache/{ticker}_{interval}.csv
- Merges all into final_dataset.csv keyed by time index
- Full validation: no empty frames passed downstream
"""
import os, json, logging, time
from datetime import datetime, timedelta
import pandas as pd
import numpy as np
import yfinance as yf

logger = logging.getLogger(__name__)

# ── Progress broadcast helper (injected from main.py) ─────────────────────────
_progress_cb = None
def set_progress_callback(fn): global _progress_cb; _progress_cb = fn
def _emit(event, data):
    if _progress_cb: _progress_cb(event, data)

class DataIngestion:
    def __init__(self, config):
        self.config = config
        base = os.path.dirname(os.path.abspath(__file__))
        self.cache_dir = os.path.join(base, 'data', 'cache')
        self.merged_path = os.path.join(base, 'data', 'final_dataset.csv')
        os.makedirs(self.cache_dir, exist_ok=True)
        self.training_years = config["data"]["training_years"]
        self.cache_hours    = config["system"]["data_cache_hours"]
        # Only use daily + 1h for training (avoids yfinance 60-day intraday limit)
        self.train_intervals = ['1d', '1h']
        self.all_intervals   = config["timeframes"]          # for live signals

    # ── Date helpers ──────────────────────────────────────────────────────────
    def get_date_range(self):
        end   = datetime.now() - timedelta(days=1)
        start = end - timedelta(days=365 * self.training_years)
        return start.strftime('%Y-%m-%d'), end.strftime('%Y-%m-%d')

    def cache_path(self, ticker, interval):
        safe = ticker.replace('/', '_').replace('^', 'IDX_').replace('-', '_')
        return os.path.join(self.cache_dir, f"{safe}_{interval}.csv")

    def is_fresh(self, path):
        if not os.path.exists(path): return False
        return (time.time() - os.path.getmtime(path)) / 3600 < self.cache_hours

    # ── Single ticker download with retry ─────────────────────────────────────
    def download_ticker(self, ticker, interval, start, end, force=False):
        path = self.cache_path(ticker, interval)
        if not force and self.is_fresh(path):
            df = self._safe_read(path)
            if df is not None and len(df) > 10:
                logger.debug(f"Cache hit: {ticker} {interval}")
                return df

        max_retries = 3
        for attempt in range(1, max_retries + 1):
            try:
                logger.info(f"[{attempt}/3] Downloading {ticker} {interval}")
                if interval in ('5m', '15m'):
                    df = self._chunked_intraday(ticker, interval)
                else:
                    df = yf.download(
                        ticker, start=start, end=end,
                        interval=interval, auto_adjust=True,
                        progress=False, threads=False
                    )
                df = self._clean(df, ticker, interval)
                if df is None or len(df) < 10:
                    raise ValueError(f"Too few rows after clean: {len(df) if df is not None else 0}")
                df.to_csv(path)
                logger.info(f"  ✓ {ticker} {interval}: {len(df)} rows → {path}")
                return df
            except Exception as e:
                logger.warning(f"  ✗ {ticker} {interval} attempt {attempt}: {e}")
                if attempt < max_retries:
                    time.sleep(2)
        logger.error(f"  FAILED: {ticker} {interval} after {max_retries} attempts")
        return None

    def _chunked_intraday(self, ticker, interval):
        """yfinance intraday limit: 5m=60d, 15m=60d. Chunk into 55-day windows."""
        chunks   = []
        end_dt   = datetime.now()
        chunk_d  = 55
        # Max lookback: 60 days for 5m/15m (hard yfinance limit)
        max_days = 59
        periods  = max(1, min(1, max_days // chunk_d))  # only 1 chunk = last 55 days

        for i in range(periods):
            ce = end_dt - timedelta(days=i * chunk_d)
            cs = ce    - timedelta(days=chunk_d)
            try:
                tmp = yf.download(
                    ticker,
                    start=cs.strftime('%Y-%m-%d'),
                    end=ce.strftime('%Y-%m-%d'),
                    interval=interval, auto_adjust=True,
                    progress=False, threads=False
                )
                if tmp is not None and not tmp.empty:
                    chunks.append(tmp)
            except Exception as e:
                logger.warning(f"    intraday chunk {i} failed for {ticker}: {e}")
            time.sleep(1.5)

        if not chunks:
            return pd.DataFrame()
        return pd.concat(chunks).drop_duplicates().sort_index()

    def _clean(self, df, ticker='?', interval='?'):
        """Validate + clean a raw yfinance DataFrame. Returns None if unusable."""
        if df is None:
            return None
        if isinstance(df, pd.DataFrame) and df.empty:
            return None
        # Flatten MultiIndex columns (yfinance ≥ 0.2.x quirk)
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)
        # Keep only OHLCV
        needed = [c for c in ['Open','High','Low','Close','Volume'] if c in df.columns]
        if 'Close' not in needed:
            logger.warning(f"  No Close column for {ticker} {interval}: {list(df.columns)}")
            return None
        df = df[needed].copy()
        df.dropna(subset=['Close'], inplace=True)
        if len(df) == 0:
            return None
        # Drop zero-volume rows (extended hours garbage)
        if 'Volume' in df.columns:
            df = df[df['Volume'] > 0]
        if len(df) < 5:
            return None
        # Forward-fill small gaps
        df = df.ffill(limit=3)
        # Normalize index to UTC
        if not isinstance(df.index, pd.DatetimeIndex):
            df.index = pd.to_datetime(df.index, utc=True)
        elif df.index.tz is None:
            df.index = df.index.tz_localize('UTC')
        else:
            df.index = df.index.tz_convert('UTC')
        df.sort_index(inplace=True)
        return df

    def _safe_read(self, path):
        try:
            df = pd.read_csv(path, index_col=0, parse_dates=True)
            if df.empty or 'Close' not in df.columns:
                return None
            return df
        except Exception:
            return None

    # ── Sequential full download ───────────────────────────────────────────────
    def download_all(self, tickers, force=False):
        """
        Download all tickers sequentially (no parallel) with progress events.
        Uses only 1d + 1h intervals for training data reliability.
        Returns dict: {ticker: {interval: ok/failed}}
        """
        start, end = self.get_date_range()
        results    = {}
        total      = len(tickers) * len(self.train_intervals)
        done       = 0

        _emit('download_start', {'total': total, 'tickers': tickers})
        logger.info(f"=== Sequential download: {len(tickers)} tickers × {len(self.train_intervals)} intervals ===")

        for ticker in tickers:
            results[ticker] = {}
            for interval in self.train_intervals:
                done += 1
                _emit('download_progress', {
                    'ticker': ticker, 'interval': interval,
                    'done': done, 'total': total,
                    'pct': round(done / total * 100, 1)
                })
                df = self.download_ticker(ticker, interval, start, end, force=force)
                ok = df is not None and len(df) >= 10
                results[ticker][interval] = 'ok' if ok else 'failed'
                time.sleep(1.0)   # polite rate-limit between tickers

        success = sum(1 for t in results.values() for s in t.values() if s == 'ok')
        _emit('download_done', {'results': results, 'success': success, 'total': total})
        logger.info(f"=== Download complete: {success}/{total} succeeded ===")
        return results

    # ── Merge all CSVs into one time-indexed dataset ──────────────────────────
    def merge_to_dataset(self, tickers, interval='1d'):
        """
        Merge per-ticker CSVs on shared time index.
        Columns prefixed with ticker symbol: AAPL_Close, AAPL_Volume, etc.
        Output: data/final_dataset.csv
        """
        logger.info(f"Merging {len(tickers)} tickers on interval={interval}")
        frames = []
        loaded = []

        for ticker in tickers:
            path = self.cache_path(ticker, interval)
            df   = self._safe_read(path)
            if df is None or len(df) < 10:
                logger.warning(f"  Skip {ticker}: no valid data at {path}")
                continue
            # Prefix columns
            df = df[['Open','High','Low','Close','Volume']].copy() if all(c in df.columns for c in ['Open','High','Low','Close','Volume']) else df[['Close']].copy()
            df.columns = [f"{ticker}_{c}" for c in df.columns]
            frames.append(df)
            loaded.append(ticker)

        if not frames:
            logger.error("Merge failed: no valid data for any ticker")
            return None, []

        merged = pd.concat(frames, axis=1, join='outer')
        merged.sort_index(inplace=True)
        # Drop rows where ALL values are NaN
        merged.dropna(how='all', inplace=True)
        merged.to_csv(self.merged_path)
        logger.info(f"  Merged dataset: {merged.shape} → {self.merged_path}")
        _emit('merge_done', {'tickers': loaded, 'rows': len(merged), 'cols': len(merged.columns)})
        return merged, loaded

    def load_merged(self):
        """Load the merged final_dataset.csv"""
        if not os.path.exists(self.merged_path):
            return None, []
        df = pd.read_csv(self.merged_path, index_col=0, parse_dates=True)
        tickers = list({c.rsplit('_', 1)[0] for c in df.columns if '_' in c})
        return df, tickers

    # ── Live signal helpers ────────────────────────────────────────────────────
    def load(self, ticker, interval):
        path = self.cache_path(ticker, interval)
        if os.path.exists(path):
            return self._safe_read(path)
        start, end = self.get_date_range()
        return self.download_ticker(ticker, interval, start, end)

    def get_spy_benchmark(self): return self.load('SPY', '1d')
    def get_vix(self):            return self.load('^VIX', '1d')

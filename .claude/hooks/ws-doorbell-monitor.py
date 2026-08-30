import asyncio, os, sys, websockets

URL = (f"ws://localhost:9889/ws/supervisor/{os.environ['CAO_TERMINAL_ID']}"
       f"?token={os.environ['CAO_TERMINAL_TOKEN']}")

def lifecycle(msg):
    print(msg, file=sys.stderr, flush=True)

async def main():
    backoff = 2
    while True:
        try:
            async with websockets.connect(URL) as ws:
                lifecycle("WS connected")
                async for frame in ws:
                    if "[CAO]" in frame:
                        print(frame, flush=True)
                    else:
                        lifecycle(frame)
                lifecycle(f"WS closed; reconnect after {backoff}s")
        except websockets.ConnectionClosed as e:
            code = e.rcvd.code if e.rcvd is not None else None
            if code == 4008:
                lifecycle("superseded (WS 4008) — monitor exiting, do not re-arm")
                return
            lifecycle(f"WS closed (code={code}); reconnect after {backoff}s")
        except Exception as e:
            lifecycle(f"connect failed ({type(e).__name__}); reconnect after {backoff}s")
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 60)

asyncio.run(main())

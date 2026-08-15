import clsx from 'clsx';
import isElectron from 'is-electron';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import styles from './synchronized-lyrics.module.css';

import { LyricLine } from '/@/renderer/features/lyrics/lyric-line';
import {
    useLyricsDisplaySettings,
    useLyricsSettings,
    usePlaybackType,
    usePlayerActions,
    usePlayerSong,
    usePlayerStatus,
} from '/@/renderer/store';
import { usePlayerTimestamp } from '/@/renderer/store/timestamp.store';
import { FullLyricsMetadata } from '/@/shared/types/domain-types';
import { PlayerStatus, PlayerType } from '/@/shared/types/types';

const mpvPlayer = isElectron() ? window.api.mpvPlayer : null;
const utils = isElectron() ? window.api.utils : null;
const mpris = isElectron() && utils?.isLinux() ? window.api.mpris : null;

export interface SynchronizedLyricsProps extends Omit<FullLyricsMetadata, 'lyrics'> {
    extraOverlayLyrics?: any;
    lyrics: any;
    offsetMs?: number;
    preview?: boolean;
    pronunciationLyrics?: any;
    romajiLyrics?: any;
    settingsKey?: string;
    style?: React.CSSProperties;
    translatedLyrics?: null | string;
    translationLyrics?: any;
}

export const SynchronizedLyrics = ({
    artist,
    lyrics,
    name,
    offsetMs,
    remote,
    romajiLyrics,
    settingsKey = 'default',
    source,
    style,
    translatedLyrics,
}: SynchronizedLyricsProps) => {
    const playbackType = usePlaybackType();
    const translatedLines = useMemo(
        () => (translatedLyrics ? translatedLyrics.split('\n') : []),
        [translatedLyrics],
    );
    const lyricsSettings = useLyricsSettings();
    const displaySettings = useLyricsDisplaySettings(settingsKey);
    const settings = {
        ...lyricsSettings,
        fontSize:
            displaySettings.fontSize && displaySettings.fontSize !== 0
                ? displaySettings.fontSize
                : 24,
        gap: displaySettings.gap && displaySettings.gap !== 0 ? displaySettings.gap : 24,
        opacityNonActive: displaySettings.opacityNonActive,
        scaleNonActive:
            displaySettings.scaleNonActive && displaySettings.scaleNonActive !== 0
                ? displaySettings.scaleNonActive
                : 0.95,
    };
    const { mediaSeekToTimestamp } = usePlayerActions();
    const status = usePlayerStatus();
    const timestamp = usePlayerTimestamp();
    const currentSong = usePlayerSong();
    const songId = currentSong?.id;

    const normalizedLyrics: [number, string][] = useMemo(() => {
        if (!lyrics || !Array.isArray(lyrics)) return [];
        return lyrics.map((line) => {
            if (Array.isArray(line)) {
                return [Number(line[0] || 0), String(line[1] || '')];
            }
            if (line && typeof line === 'object') {
                return [
                    Number('startMs' in line ? line.startMs : line[0] || 0),
                    String('text' in line ? line.text : line[1] || ''),
                ];
            }
            return [0, ''];
        });
    }, [lyrics]);

    const normalizedRomaji: [number, string][] | undefined = useMemo(() => {
        if (!romajiLyrics || !Array.isArray(romajiLyrics)) return undefined;
        return romajiLyrics.map((line) => {
            if (Array.isArray(line)) {
                return [Number(line[0] || 0), String(line[1] || '')];
            }
            if (line && typeof line === 'object') {
                return [
                    Number('startMs' in line ? line.startMs : line[0] || 0),
                    String('text' in line ? line.text : line[1] || ''),
                ];
            }
            return [0, ''];
        });
    }, [romajiLyrics]);

    const effectiveOffsetMs = offsetMs ?? 0;

    const handleSeek = useCallback(
        (time: number) => {
            if (playbackType === PlayerType.LOCAL && mpvPlayer) {
                mpvPlayer.seekTo(time);
            } else {
                mpris?.updateSeek(time);
                mediaSeekToTimestamp(time);
            }
        },
        [mediaSeekToTimestamp, playbackType],
    );

    const handleLineClick = useCallback(
        (e: React.MouseEvent<HTMLDivElement>) => {
            const target = e.target as HTMLElement;
            const lineNode = target.closest('.lyric-line.synchronized');
            if (!lineNode) return;

            const timeAttr = lineNode.getAttribute('data-time');
            if (!timeAttr) return;

            const time = parseInt(timeAttr, 10);
            if (time > 0 && Number.isFinite(time)) {
                handleSeek(time / 1000);
            }
        },
        [handleSeek],
    );

    const lyricTimer = useRef<null | ReturnType<typeof setTimeout>>(null);
    const lyricRef = useRef<null | [number, string][]>(null);
    const timerEpoch = useRef(0);

    const delayMsRef = useRef(effectiveOffsetMs);
    const followRef = useRef(settings.follow);
    const userScrollingRef = useRef(false);
    const scrollTimeoutRef = useRef<null | ReturnType<typeof setTimeout>>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const programmaticScrollRef = useRef(false);
    const programmaticScrollTimeoutRef = useRef<null | ReturnType<typeof setTimeout>>(null);

    const lastBaseTimeMsRef = useRef(0);
    const lastLocalTimeMsRef = useRef(0);
    const rAFRef = useRef<number | null>(null);
    const lastActiveIndexRef = useRef(-1);
    const lastSongIdRef = useRef<string | null>(null);

    const getCurrentLyric = (timeInMs: number) => {
        const activeLyrics = lyricRef.current;
        if (!activeLyrics?.length) {
            return -1;
        }

        let index = -1;
        for (let idx = 0; idx < activeLyrics.length; idx += 1) {
            if (timeInMs < activeLyrics[idx][0]) {
                break;
            }
            index = idx;
        }

        return index;
    };

    const setCurrentLyricRef = useRef<
        (timeInMs: number, epoch?: number, targetIndex?: number) => void
    >(() => {});

    const setCurrentLyric = useCallback(
        (timeInMs: number, epoch?: number, targetIndex?: number) => {
            if (lyricTimer.current) {
                clearTimeout(lyricTimer.current);
            }
            const start = performance.now();
            let nextEpoch: number;

            if (epoch === undefined) {
                timerEpoch.current = (timerEpoch.current + 1) % 10000;
                nextEpoch = timerEpoch.current;
            } else if (epoch !== timerEpoch.current) {
                return;
            } else {
                nextEpoch = epoch;
            }

            let index: number;

            if (targetIndex === undefined) {
                index = getCurrentLyric(timeInMs);
            } else {
                index = targetIndex;
            }

            if (index === -1) {
                if (lastActiveIndexRef.current !== -1) {
                    document
                        .querySelectorAll('.synchronized-lyrics .active')
                        .forEach((node) => node.classList.remove('active'));
                    lastActiveIndexRef.current = -1;
                }

                const activeLyrics = lyricRef.current;
                if (!activeLyrics?.length) {
                    return;
                }

                const firstTime = activeLyrics[0][0];
                if (timeInMs < firstTime) {
                    const elapsed = performance.now() - start;
                    const delay = Math.max(0, firstTime - timeInMs - elapsed);
                    lyricTimer.current = setTimeout(() => {
                        setCurrentLyricRef.current(firstTime, nextEpoch, 0);
                    }, delay);
                }

                return;
            }

            const doc = document.getElementById(
                'sychronized-lyrics-scroll-container',
            ) as HTMLElement;
            const currentLyric = document.querySelector(`#lyric-${index}`) as HTMLElement;

            if (currentLyric === null) {
                return;
            }

            if (
                index !== lastActiveIndexRef.current ||
                !currentLyric.classList.contains('active')
            ) {
                document
                    .querySelectorAll('.synchronized-lyrics .active')
                    .forEach((node) => node.classList.remove('active'));

                currentLyric.classList.add('active');

                const offsetTop = currentLyric.offsetTop - doc?.clientHeight / 2 || 0;
                if (followRef.current && !userScrollingRef.current) {
                    programmaticScrollRef.current = true;
                    doc?.scroll({ behavior: 'smooth', top: offsetTop });
                }

                lastActiveIndexRef.current = index;
            }

            const wordNodes = currentLyric.querySelectorAll('.lyric-word');
            const activeLyrics = lyricRef.current;
            const nextLineTime = (activeLyrics && index < activeLyrics.length - 1)
                ? activeLyrics[index + 1][0]
                : Infinity;

            for (let i = 0; i < wordNodes.length; i++) {
                const wordNode = wordNodes[i] as HTMLElement;
                const wordTime = parseInt(wordNode.getAttribute('data-time') || '0', 10);

                let nextWordTime = nextLineTime;
                if (i < wordNodes.length - 1) {
                    const parsedNext = parseInt(wordNodes[i + 1].getAttribute('data-time') || '0', 10);
                    if (parsedNext > wordTime) {
                        nextWordTime = parsedNext;
                    }
                }

                let progress = 0;
                if (timeInMs >= nextWordTime) {
                    progress = 100;
                    wordNode.classList.add('word-active');
                } else if (timeInMs >= wordTime) {
                    const duration = nextWordTime - wordTime;
                    if (duration > 0) {
                        progress = Math.min(100, Math.max(0, ((timeInMs - wordTime) / duration) * 100));
                    } else {
                        progress = 100;
                    }
                    wordNode.classList.add('word-active');
                } else {
                    progress = 0;
                    wordNode.classList.remove('word-active');
                }

                wordNode.style.setProperty('--progress', `${progress}%`);
            }

            if (index !== lyricRef.current!.length - 1) {
                const nextTime = lyricRef.current![index + 1][0];

                const elapsed = performance.now() - start;

                lyricTimer.current = setTimeout(
                    () => {
                        setCurrentLyricRef.current(nextTime, nextEpoch, index + 1);
                    },
                    nextTime - timeInMs - elapsed,
                );
            }
        },
        [],
    );

    useEffect(() => {
        setCurrentLyricRef.current = setCurrentLyric;
    }, [setCurrentLyric]);

    useEffect(() => {
        followRef.current = settings.follow;
    }, [settings.follow]);

    useEffect(() => {
        lyricRef.current = normalizedLyrics;
        lastActiveIndexRef.current = -1;

        if (status === PlayerStatus.PLAYING) {
            setCurrentLyric(timestamp * 1000 + delayMsRef.current);

            return () => {
                if (lyricTimer.current) clearTimeout(lyricTimer.current);
            };
        }

        return () => {};
    }, [normalizedLyrics, setCurrentLyric, status, timestamp]);

    useEffect(() => {
        const newOffset = offsetMs ?? 0;
        const changed = delayMsRef.current !== newOffset;

        if (!changed) {
            return;
        }

        if (lyricTimer.current) {
            clearTimeout(lyricTimer.current);
        }

        delayMsRef.current = newOffset;

        setCurrentLyric(timestamp * 1000 + delayMsRef.current);
    }, [setCurrentLyric, offsetMs, timestamp]);

    useEffect(() => {
        if (status !== PlayerStatus.PLAYING) {
            if (lyricTimer.current) {
                clearTimeout(lyricTimer.current);
            }

            return;
        }

        if (lyricTimer.current) {
            clearTimeout(lyricTimer.current);
        }

        setCurrentLyric(timestamp * 1000 + delayMsRef.current);
    }, [timestamp, setCurrentLyric, status]);

    useEffect(() => {
        if (lyricTimer.current) {
            clearTimeout(lyricTimer.current);
        }

        timerEpoch.current += 1;
    }, []);

    useEffect(() => {
        lastBaseTimeMsRef.current = timestamp * 1000 + effectiveOffsetMs;
        lastLocalTimeMsRef.current = performance.now();
        lastSongIdRef.current = songId || null;
    }, [timestamp, effectiveOffsetMs, songId]);

    useEffect(() => {
        let active = true;

        const loop = () => {
            if (!active) return;

            if (status === PlayerStatus.PLAYING && lastSongIdRef.current === (songId || null)) {
                const now = performance.now();
                const baseTime = lastBaseTimeMsRef.current;
                const localTime = lastLocalTimeMsRef.current;
                const timeInMs = baseTime + (now - localTime);

                setCurrentLyric(timeInMs);
            }

            rAFRef.current = requestAnimationFrame(loop);
        };

        if (status === PlayerStatus.PLAYING) {
            rAFRef.current = requestAnimationFrame(loop);
        }

        return () => {
            active = false;
            if (rAFRef.current) {
                cancelAnimationFrame(rAFRef.current);
            }
        };
    }, [status, setCurrentLyric, songId]);

    useEffect(() => {
        const container =
            containerRef.current ||
            (document.getElementById('sychronized-lyrics-scroll-container') as HTMLElement);
        if (!container) return;

        const handleScroll = () => {
            if (programmaticScrollRef.current) {
                if (programmaticScrollTimeoutRef.current) {
                    clearTimeout(programmaticScrollTimeoutRef.current);
                }

                programmaticScrollTimeoutRef.current = setTimeout(() => {
                    programmaticScrollRef.current = false;
                }, 150);

                return;
            }

            userScrollingRef.current = true;

            if (scrollTimeoutRef.current) {
                clearTimeout(scrollTimeoutRef.current);
            }

            scrollTimeoutRef.current = setTimeout(() => {
                userScrollingRef.current = false;
            }, 3000);
        };

        container.addEventListener('scroll', handleScroll, { passive: true });

        return () => {
            container.removeEventListener('scroll', handleScroll);
            if (scrollTimeoutRef.current) {
                clearTimeout(scrollTimeoutRef.current);
            }

            if (programmaticScrollTimeoutRef.current) {
                clearTimeout(programmaticScrollTimeoutRef.current);
            }
        };
    }, []);

    const hideScrollbar = () => {
        const doc = document.getElementById('sychronized-lyrics-scroll-container') as HTMLElement;
        doc?.classList.add('hide-scrollbar');
    };

    const showScrollbar = () => {
        const doc = document.getElementById('sychronized-lyrics-scroll-container') as HTMLElement;
        doc?.classList.remove('hide-scrollbar');
    };

    return (
        <div
            className={clsx(styles.container, 'synchronized-lyrics overlay-scrollbar')}
            id="sychronized-lyrics-scroll-container"
            onClick={handleLineClick}
            onMouseEnter={showScrollbar}
            onMouseLeave={hideScrollbar}
            ref={containerRef}
            style={
                {
                    '--lyric-opacity': settings.opacityNonActive,
                    '--lyric-scale': settings.scaleNonActive,
                    '--lyric-scale-origin': settings.alignment,
                    gap: `${settings.gap}px`,
                    ...style,
                } as React.CSSProperties
            }
        >
            {settings.showProvider && source && (
                <LyricLine
                    alignment={settings.alignment}
                    className="lyric-credit"
                    fontSize={settings.fontSize}
                    text={`Provided by ${source}`}
                />
            )}
            {settings.showMatch && remote && (
                <LyricLine
                    alignment={settings.alignment}
                    className="lyric-credit"
                    fontSize={settings.fontSize}
                    text={`"${name} by ${artist}"`}
                />
            )}
            {normalizedLyrics.map(([time, text], idx) => (
                <LyricLine
                    alignment={settings.alignment}
                    className="lyric-line synchronized"
                    dataTime={time}
                    fontSize={settings.fontSize}
                    id={`lyric-${idx}`}
                    key={idx}
                    romajiText={normalizedRomaji?.[idx]?.[1]}
                    text={text}
                    translatedText={translatedLines[idx]}
                />
            ))}
        </div>
    );
};

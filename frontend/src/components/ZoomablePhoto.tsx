import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./ZoomablePhoto.module.css";

type PhotoState = { objectUrl: string | null; isError: boolean };

type Props = {
	alt: string;
	thumbUrl: string;
	/** 原圖的 hook（`() => useMealPhoto(id)` 之類）。**只有打開時才呼叫**——
	 *  清單裡十幾張照片不會一次抓十幾張原圖。 */
	useFull: () => PhotoState;
};

/** 清單裡的照片：顯示縮圖，點了全螢幕看原圖（縮圖規格 §4.2）。 */
export function ZoomablePhoto({ alt, thumbUrl, useFull }: Props) {
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const close = useCallback(() => {
		setOpen(false);
		triggerRef.current?.focus();
	}, []);

	return (
		<>
			<button
				ref={triggerRef}
				type="button"
				className={styles.trigger}
				aria-label={`看大圖：${alt}`}
				onClick={() => setOpen(true)}
			>
				<img src={thumbUrl} alt={alt} />
			</button>
			{open && (
				<Viewer
					alt={alt}
					thumbUrl={thumbUrl}
					useFull={useFull}
					onClose={close}
				/>
			)}
		</>
	);
}

function Viewer({
	alt,
	thumbUrl,
	useFull,
	onClose,
}: Props & { onClose: () => void }) {
	const full = useFull();
	const closeRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		closeRef.current?.focus();
	}, []);

	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") onClose();
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: 鍵盤用 Esc（掛在 window）與「關閉」按鈕；點遮罩只是滑鼠／觸控的捷徑
		<div
			role="dialog"
			aria-modal="true"
			aria-label={alt}
			className={styles.backdrop}
			onClick={(event) => {
				// 只有點到遮罩本身才關——點圖片不關（想看細節時一碰就關掉很煩）。
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<button
				ref={closeRef}
				type="button"
				className={styles.close}
				onClick={onClose}
			>
				關閉
			</button>
			<img className={styles.full} src={full.objectUrl ?? thumbUrl} alt={alt} />
		</div>
	);
}

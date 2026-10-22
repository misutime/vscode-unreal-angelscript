// 左键手势只能处于空闲、等待点击判定或拖图中的一个阶段。
enum EPanguLeftMousePhase
{
	Idle,
	Pressed,
	Dragging
}

// 蓝图注册输入并转发事件；控制器负责左键点选、拖图和右键点击寻路。
class AAsasiPlayerController : APlayerController
{
	// 组件声明。
	// 默认相机控制组件，负责镜头缩放、重置与按键平移。
	UPROPERTY(DefaultComponent)
	UCameraControllerComponent CameraController;

	config
	{
		// 所有角色接受移动命令时播放。
		UPROPERTY(Category = "Asasi Feedback")
		UNiagaraSystem MoveCommandSuccessFX;
		// 任一角色拒绝移动命令时播放。
		UPROPERTY(Category = "Asasi Feedback")
		UNiagaraSystem MoveCommandFailureFX;

		// 拖图启动阈值（像素），达到后本次手势不再点选。
		float DragStartDistancePixels = 6.0;
		// 多角色目标分散半径（cm），以中心落点为基准。
		float TargetSpreadRadius = 220.0;
	}

	state
	{
		// 当前选择集合，选中圆环和移动命令都以它为准。
		TArray<AAsasiPlayerCharacter> SelectedCharacters;
		// 选择修饰键（Shift）当前是否按住。
		bool bMultiSelectKeyDown = false;
		// 左键手势阶段；进入拖图后，松开时不再点选。
		EPanguLeftMousePhase LeftMousePhase = EPanguLeftMousePhase::Idle;
		// 按下左键时的 Shift 快照，决定本次是否增减选择。
		bool bMultiSelectOnMouseDown = false;

		// 按下时的鼠标屏幕坐标（像素）。
		FVector2D MouseDownScreenPosition;
		// 拖图平面高度（cm），取按下时的命中点 Z。
		float DragPlaneHeight = 0.0;
		// 按下时的平面交点，作为拖图的固定世界锚点（cm）。
		FVector MouseDownWorldPosition;
	}
}

// 控制生命周期。
impl AAsasiPlayerController
{
	// 输入初始化由蓝图调用 InitializeControls，这里只输出开始日志。
	UFUNCTION(BlueprintOverride)
	void BeginPlay()
	{
		Print("PlayerController BeginPlay");
	}

	// 蓝图开始控制时调用，设置鼠标、悬停和输入模式。
	UFUNCTION(BlueprintCallable, Category = "Asasi|Controller")
	void InitializeControls()
	{
		bShowMouseCursor = true;
		// 悬停与点选共用选取通道；寻路落点使用 Visibility。
		CurrentClickTraceChannel = ECollisionChannel::AsasiSelection;
		bEnableMouseOverEvents = true;

		// UI 优先处理输入，未处理的事件交给游戏。
		// 不指定 UI 焦点；鼠标不锁定，捕获时不隐藏。
		Widget::SetInputMode_GameAndUIEx(this, nullptr, EMouseLockMode::DoNotLock, false);
	}

	// 结束控制：取消手势并清空选择，输入映射由蓝图解除。
	UFUNCTION(BlueprintCallable, Category = "Asasi|Controller")
	void ShutdownControls()
	{
		CancelLeftMouseAction();
		bMultiSelectKeyDown = false;
		TArray<AAsasiPlayerCharacter> EmptySelection;
		ApplySelection(EmptySelection);
	}
}

// 左键手势：按下记录、持续更新、松开或取消。
impl AAsasiPlayerController
{
	// 左键按下：记录拖图锚点和本次选择模式。
	UFUNCTION(BlueprintCallable, Category = "Asasi|PlayerController")
	void BeginLeftMouseAction()
	{
		// 先取消残留手势，不改变已选角色。
		CancelLeftMouseAction();

		FHitResult Hit;
		// 优先取场景命中；仅命中选取胶囊时也能开始手势。
		if (!ReadMousePosition(MouseDownScreenPosition) || (!GetSceneHitUnderMouse(Hit) && !GetSelectionHitUnderMouse(Hit)))
			return;
		// 固定平面高度，跨越高台时不改变拖图基准。
		DragPlaneHeight = Hit.ImpactPoint.Z;
		if (!GetWorldPointOnPlane(MouseDownScreenPosition, DragPlaneHeight, MouseDownWorldPosition))
			return;

		LeftMousePhase = EPanguLeftMousePhase::Pressed;
		bMultiSelectOnMouseDown = bMultiSelectKeyDown;
	}

	// 左键持续输入：达到启动阈值后拖动镜头。
	UFUNCTION(BlueprintCallable, Category = "Asasi|PlayerController")
	void UpdateLeftMouseAction()
	{
		if (LeftMousePhase == EPanguLeftMousePhase::Idle)
			return;

		// 鼠标位置无效或离开视口时取消手势。
		FVector2D MouseScreenPosition;
		if (!ReadMousePosition(MouseScreenPosition))
		{
			CancelLeftMouseAction();
			return;
		}
		// 阈值只用于启动拖图，启动后持续更新至手势结束。
		if (LeftMousePhase == EPanguLeftMousePhase::Pressed && (MouseScreenPosition - MouseDownScreenPosition).Size() < DragStartDistancePixels)
			return;

		LeftMousePhase = EPanguLeftMousePhase::Dragging;

		// 用当前鼠标射线求同一平面的交点。
		FVector MouseWorldPosition;
		APawn Pawn = GetControlledPawn();
		if (IsValid(Pawn) && GetWorldPointOnPlane(MouseScreenPosition, DragPlaneHeight, MouseWorldPosition))
		{
			// 平移相机 Pawn，使固定世界锚点始终位于鼠标下方。
			FVector Delta = MouseDownWorldPosition - MouseWorldPosition;
			Delta.Z = 0.0;
			Pawn.SetActorLocation(Pawn.ActorLocation + Delta);
		}
	}

	// 左键松开：拖图只结束手势，点击则更新选择。
	UFUNCTION(BlueprintCallable, Category = "Asasi|PlayerController")
	void EndLeftMouseAction()
	{
		if (LeftMousePhase == EPanguLeftMousePhase::Idle)
			return;

		// 补采松开位置，避免漏判最后一次移动；离开视口会取消手势。
		UpdateLeftMouseAction();
		if (LeftMousePhase == EPanguLeftMousePhase::Idle)
			return;
		if (LeftMousePhase == EPanguLeftMousePhase::Pressed)
			ApplyClickSelection();
		CancelLeftMouseAction();
	}

	// 取消或结束左键手势，保留当前选择。
	UFUNCTION(BlueprintCallable, Category = "Asasi|PlayerController")
	void CancelLeftMouseAction()
	{
		LeftMousePhase = EPanguLeftMousePhase::Idle;
	}
}

// 选择管理：修饰键、选择查询和圆环同步。
impl AAsasiPlayerController
{
	// 记录 Shift 状态，供下一次左键按下取快照。
	UFUNCTION(BlueprintCallable, Category = "Asasi|Selection")
	void SetMultiSelectKeyDown(bool bDown)
	{
		bMultiSelectKeyDown = bDown;
	}

	// 返回仍有效的已选角色，不修改内部集合。
	UFUNCTION(BlueprintPure, Category = "Asasi|Selection")
	TArray<AAsasiPlayerCharacter> GetSelectedCharacters() const
	{
		TArray<AAsasiPlayerCharacter> Characters;
		for (AAsasiPlayerCharacter Character : SelectedCharacters)
			if (IsValid(Character))
				Characters.Add(Character);
		return Characters;
	}

	// 只在有效点击结束时调用；选择模式读取按下时的 Shift 快照。
	private void ApplyClickSelection()
	{
		// 普通点击替换或清空；Shift 点击增减角色，空白处不改选择。
		FHitResult Hit;
		if (GetSelectionHitUnderMouse(Hit))
		{
			AAsasiPlayerCharacter Character = Cast<AAsasiPlayerCharacter>(Hit.Actor);
			TArray<AAsasiPlayerCharacter> NewSelectedCharacters;
			if (bMultiSelectOnMouseDown)
				NewSelectedCharacters = GetSelectedCharacters();
			if (Character != nullptr)
			{
				if (NewSelectedCharacters.Contains(Character))
					NewSelectedCharacters.Remove(Character);
				else
					NewSelectedCharacters.Add(Character);
			}
			ApplySelection(NewSelectedCharacters);
		}
		else if (!bMultiSelectOnMouseDown)
		{
			TArray<AAsasiPlayerCharacter> EmptySelection;
			ApplySelection(EmptySelection);
		}
	}

	// 统一更新选择集合并同步选中圆环，跳过已销毁的角色。
	private void ApplySelection(const TArray<AAsasiPlayerCharacter>& Characters)
	{
		for (AAsasiPlayerCharacter Character : SelectedCharacters)
		{
			if (IsValid(Character) && !Characters.Contains(Character))
				Character.SetSelectionHighlight(false);
		}
		SelectedCharacters = Characters;
		for (AAsasiPlayerCharacter Character : SelectedCharacters)
		{
			if (IsValid(Character))
				Character.SetSelectionHighlight(true);
		}
	}
}

// 移动命令：提交寻路请求并计算各角色的落点。
impl AAsasiPlayerController
{
	// 右键按下提交一次寻路命令，按住和松开不更新目标。
	UFUNCTION(BlueprintCallable, Category = "Asasi|Orders")
	void MoveSelectedCharactersToMouse()
	{
		// 移动命令在权威端提交。
		if (!HasAuthority())
			return;
		TArray<AAsasiPlayerCharacter> Characters = GetSelectedCharacters();
		if (Characters.IsEmpty())
			return;
		// 先取场景落点，再用选取射线判断目标角色。
		FHitResult Hit;
		if (!GetSceneHitUnderMouse(Hit))
			return;
		FVector TargetPosition = Hit.ImpactPoint;
		FHitResult CharacterHit;
		AAsasiPlayerCharacter TargetCharacter = GetSelectionHitUnderMouse(CharacterHit) ? Cast<AAsasiPlayerCharacter>(CharacterHit.Actor) : nullptr;
		// 已选角色不作为攻击目标；未选角色以其位置作为落点。
		if (Characters.Contains(TargetCharacter))
			TargetCharacter = nullptr;
		if (TargetCharacter != nullptr)
			TargetPosition = TargetCharacter.ActorLocation;
		AAsasiPlayerCharacter ClosestCharacter = FindClosestCharacter(Characters, TargetPosition);
		bool bAccepted = true;
		int Index = 0;
		for (AAsasiPlayerCharacter Character : Characters)
		{
			if (!IsValid(Character))
				continue;
			// 最近角色使用中心落点，其余角色按选择顺序分散。
			FVector Destination = TargetPosition;
			if (Character != ClosestCharacter)
			{
				Destination = GetSpreadTargetPosition(TargetPosition, Index, Characters.Num() - 1);
				Index += 1;
			}
			// 只有中心角色接收攻击目标，其他角色只执行移动。
			if (!Character.MoveToPosition(Destination, Character == ClosestCharacter ? TargetCharacter : nullptr))
				bAccepted = false;
		}
		// 反馈表示命令是否被接受，不表示已经到达目标。
		UNiagaraSystem Effect = bAccepted ? MoveCommandSuccessFX : MoveCommandFailureFX;
		if (Effect != nullptr)
			Niagara::SpawnSystemAtLocation(Effect, Hit.ImpactPoint);
	}

	// 调用方已取得非空、有效的选择快照；最近角色负责中心落点。
	private AAsasiPlayerCharacter FindClosestCharacter(const TArray<AAsasiPlayerCharacter>& Characters, FVector TargetPosition) const
	{
		AAsasiPlayerCharacter ClosestCharacter = Characters[0];
		for (AAsasiPlayerCharacter Character : Characters)
			if ((Character.ActorLocation - TargetPosition).SizeSquared() < (ClosestCharacter.ActorLocation - TargetPosition).SizeSquared())
				ClosestCharacter = Character;
		return ClosestCharacter;
	}

	// 其余角色按索引均分圆周落点；只在多选时调用，Count 至少为 1。
	private FVector GetSpreadTargetPosition(FVector TargetPosition, int Index, int Count) const
	{
		float Angle = 2.0 * PI * Index / Count;
		return TargetPosition + FVector(Math::Cos(Angle), Math::Sin(Angle), 0.0) * TargetSpreadRadius;
	}
}

// 共用查询：鼠标位置、射线命中和拖图平面交点。
impl AAsasiPlayerController
{
	// 按当前鼠标位置查询 Visibility 命中，用于寻路落点和拖图平面。
	private bool GetSceneHitUnderMouse(FHitResult& OutHit) const
	{
		FVector2D Mouse;
		return ReadMousePosition(Mouse) && GetHitResultUnderCursorByChannel(ETraceTypeQuery::Visibility, false, OutHit);
	}

	// 选取射线与悬停共用通道，场景遮挡可阻止选中后方角色。
	private bool GetSelectionHitUnderMouse(FHitResult& OutHit) const
	{
		FVector2D Mouse;
		return ReadMousePosition(Mouse) && GetHitResultUnderCursorByChannel(UCollisionProfile::ConvertToTraceType(CurrentClickTraceChannel), false, OutHit);
	}

	// 读取当前鼠标视口坐标（像素），不区分左右键；视口外返回失败。
	private bool ReadMousePosition(FVector2D& OutPosition) const
	{
		float32 X = 0.0;
		float32 Y = 0.0;
		if (!GetMousePosition(X, Y))
			return false;
		int Width = 0;
		int Height = 0;
		GetViewportSize(Width, Height);
		OutPosition = FVector2D(X, Y);
		return X >= 0 && Y >= 0 && X < Width && Y < Height;
	}

	// 求屏幕射线与指定水平面的交点，用于拖图。
	private bool GetWorldPointOnPlane(FVector2D Screen, float Height, FVector& OutPoint) const
	{
		FVector Origin;
		FVector Direction;
		// 排除无法投射或近乎平行的射线，以及射线后方的交点。
		if (!DeprojectScreenPositionToWorld(float32(Screen.X), float32(Screen.Y), Origin, Direction) || Math::Abs(Direction.Z) < 0.0001)
			return false;
		float Distance = (Height - Origin.Z) / Direction.Z;
		if (Distance < 0.0)
			return false;
		OutPoint = Origin + Direction * Distance;
		return true;
	}
}

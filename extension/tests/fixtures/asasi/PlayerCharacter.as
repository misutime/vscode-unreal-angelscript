// 玩家可选中并下达命令的角色；AIController 负责寻路，CharacterMovement 负责移动。
class AAsasiPlayerCharacter : ACharacter
{
	// 组件声明与构造默认值。

	// 默认组件由 UE 创建；选取胶囊只查询命中，不参与移动碰撞和导航。
	UPROPERTY(DefaultComponent, Attach = CollisionCylinder)
	UCapsuleComponent SelectionCapsule;
	default SelectionCapsule.SetCollisionEnabled(ECollisionEnabled::QueryOnly);
	default SelectionCapsule.SetCollisionObjectType(ECollisionChannel::WorldDynamic);
	default SelectionCapsule.SetCollisionResponseToAllChannels(ECollisionResponse::ECR_Ignore);
	default SelectionCapsule.SetCollisionResponseToChannel(ECollisionChannel::AsasiSelection, ECollisionResponse::ECR_Block);
	default SelectionCapsule.SetGenerateOverlapEvents(false);
	default SelectionCapsule.bCanEverAffectNavigation = false;
	default SelectionCapsule.bEditableWhenInherited = false;
	default SelectionCapsule.SetHiddenInGame(true);

	// 地面圆环，水平尺寸读取选取胶囊半径，颜色由选择状态决定。
	UPROPERTY(DefaultComponent, Attach = CollisionCylinder)
	UDecalComponent SelectionRing;
	default SelectionRing.SetVisibility(false);
	default SelectionRing.bEditableWhenInherited = false;

	// 地面移动指示线；世界尺寸独立于角色缩放，只负责表现。
	UPROPERTY(DefaultComponent, Attach = CollisionCylinder)
	UDecalComponent MoveIndicator;
	default MoveIndicator.SetVisibility(false);
	default MoveIndicator.bEditableWhenInherited = false;

	config
	{
		// 圆环材质；不配置时隐藏圆环。
		UPROPERTY(Category = "Asasi|Selection")
		UMaterialInterface SelectionRingMaterial;

		// 连续箭头与终点圈材质；不配置时隐藏移动指示线。
		UPROPERTY(Category = "Asasi|Movement")
		UMaterialInterface MoveIndicatorMaterial;

		// 攻击状态的循环表现；循环段与混入、混出由蒙太奇资产配置。
		UPROPERTY(Category = "Asasi|Attack")
		UAnimMontage AttackMontage;

		// 选取与圆环共用的水平半径（cm），不影响移动胶囊和导航。
		float SelectionCapsuleRadius = 45.0;

		// 选取半高（cm），UE 胶囊组件保证它不小于实际半径。
		float SelectionCapsuleHalfHeight = 100.0;

		// 空地到点容差与近战站位精度预算（cm），不附加胶囊半径。
		float MoveAcceptanceRadius = 2.0;
		// 普通近战的最大胶囊表面间隙（cm），也是从远处接近时的目标间隙。
		float AttackGap = 80.0;
		// 移动指示线贴花的完整宽度（cm），箭头与终点圈在材质内按此尺寸派生。
		float MoveIndicatorWidth = 64.0;
	}

	state
	{
		bool bMoveActive = false;
		// 本次寻路到达后尝试攻击的角色；目标位置仍由 AI 路径保存。
		AAsasiPlayerCharacter MoveTargetCharacter;
		// 当前互攻对象；双方互相引用表示攻击状态，不另存布尔量或动画计时。
		AAsasiPlayerCharacter AttackTarget;
		bool bHovered = false;
		// 只记录选中表现，实际选择集合由玩家控制器维护。
		bool bSelectionHighlighted = false;
		// 每段路径使用独立贴花；动态材质由贴花持有，按需创建并复用。
		TArray<UDecalComponent> MoveIndicatorSegments;
	}
}

// 生命周期：初始化组件，更新移动、攻击与指示线，结束时解除对方的攻击状态。
impl AAsasiPlayerCharacter
{
	// 初始化选取与移动贴花；不改变移动胶囊和导航规格。
	UFUNCTION(BlueprintOverride)
	void BeginPlay()
	{
		// 应用脚本尺寸；半径至少 1 cm，半高约束交给 UE 胶囊组件。
		float SelectionRadius = Math::Max(1.0, SelectionCapsuleRadius);
		SelectionCapsule.SetCapsuleSize(SelectionRadius, SelectionCapsuleHalfHeight);
		// 选取通道统一交给独立胶囊，不读取移动胶囊和网格的蓝图响应。
		CapsuleComponent.SetCollisionResponseToChannel(ECollisionChannel::AsasiSelection, ECollisionResponse::ECR_Ignore);
		Mesh.SetCollisionResponseToChannel(ECollisionChannel::AsasiSelection, ECollisionResponse::ECR_Ignore);

		SelectionRing.SetDecalMaterial(SelectionRingMaterial);
		SelectionRing.SetFadeScreenSize(0.0);
		// 向下投射到脚下，浅投射范围避免覆盖相邻楼层。
		SelectionRing.SetRelativeRotation(FRotator(-90.0, 0.0, 0.0));
		SelectionRing.SetRelativeLocation(FVector(0.0, 0.0, -CapsuleComponent.GetUnscaledCapsuleHalfHeight() + 12.0));
		// 材质外缘的 UV 半径为 0.48；补偿后圆环外半径等于选取胶囊半径。
		float RingRadius = SelectionCapsule.GetUnscaledCapsuleRadius() / 0.96;
		FVector DecalSize = SelectionRing.DecalSize;
		SelectionRing.SetRelativeScale3D(FVector(28.0 / DecalSize.X, RingRadius / DecalSize.Y, RingRadius / DecalSize.Z));
		Mesh.SetReceivesDecals(false);
		UpdateSelectionRing();
		if (IsValid(MoveIndicatorMaterial))
			InitializeMoveIndicatorSegment(MoveIndicator);
	}

	UFUNCTION(BlueprintOverride)
	void Tick(float DeltaSeconds)
	{
		UpdateMoveCompletion();
		UpdateAttack();
		UpdateMoveIndicator();
	}

	UFUNCTION(BlueprintOverride)
	void EndPlay(EEndPlayReason EndPlayReason)
	{
		StopAttack();
	}
}

// 选择表现：悬停与选中独立记录，共用圆环更新。
impl AAsasiPlayerCharacter
{
	UFUNCTION(BlueprintOverride)
	void ActorBeginCursorOver()
	{
		bHovered = true;
		UpdateSelectionRing();
	}

	UFUNCTION(BlueprintOverride)
	void ActorEndCursorOver()
	{
		bHovered = false;
		UpdateSelectionRing();
	}

	// 控制器同步选中表现，悬停状态不改变实际选择。
	void SetSelectionHighlight(bool bEnabled)
	{
		bSelectionHighlighted = bEnabled;
		UpdateSelectionRing();
		UpdateMoveIndicator();
	}

	// 选中显示绿色，单独悬停显示黄色；选中优先。
	private void UpdateSelectionRing()
	{
		FLinearColor Color = bSelectionHighlighted ? FLinearColor(0.05, 1.0, 0.12, 1.0) : FLinearColor(1.0, 0.75, 0.05, 1.0);
		SelectionRing.SetDecalColor(Color);
		SelectionRing.SetVisibility(SelectionRingMaterial != nullptr && (bHovered || bSelectionHighlighted));
	}
}

// 移动指示线：读取剩余导航路径，逐段更新地面箭头表现。
impl AAsasiPlayerCharacter
{
	// 只读取 UE 当前路径与进度，不另存目标或发起寻路；重算后的路径在下一帧显示。
	private void UpdateMoveIndicator()
	{
		AAIController AI = Cast<AAIController>(GetController());
		if (!bSelectionHighlighted || !bMoveActive || MoveIndicatorSegments.IsEmpty() || !IsValid(AI) || AI.GetMoveStatus() != EPathFollowingStatus::Moving)
		{
			HideMoveIndicator();
			return;
		}

		TArray<FVector> Points = AIHelper::GetCurrentPathPoints(AI);
		int PathIndex = AIHelper::GetCurrentPathIndex(AI);
		if (PathIndex < 0 || PathIndex + 1 >= Points.Num())
		{
			HideMoveIndicator();
			return;
		}
		// 当前段从角色脚下开始；已到达的路径点不再绘制。
		FVector Start = ActorLocation - FVector(0.0, 0.0, CapsuleComponent.GetScaledCapsuleHalfHeight());
		float RemainingDistance = (Points[PathIndex + 1] - Start).Size2D();
		for (int Index = PathIndex + 2; Index < Points.Num(); ++Index)
			RemainingDistance += (Points[Index] - Points[Index - 1]).Size2D();

		int SegmentIndex = 0;
		float StartOffset = SelectionCapsule.GetScaledCapsuleRadius();
		for (int Index = PathIndex + 1; Index < Points.Num(); ++Index)
		{
			FVector Goal = Points[Index];
			float Distance = (Goal - Start).Size2D();
			RemainingDistance -= Distance;
			bool bLastSegment = Index == Points.Num() - 1;
			// 跳过重复点，但保留最终落点圈。
			if (Distance > 0.01 || bLastSegment)
			{
				if (SegmentIndex == MoveIndicatorSegments.Num())
					InitializeMoveIndicatorSegment(UDecalComponent::Create(this));
				UpdateMoveIndicatorSegment(SegmentIndex, Start, Goal, StartOffset, RemainingDistance, bLastSegment);
				++SegmentIndex;
			}
			StartOffset = Math::Max(0.0, StartOffset - Distance);
			Start = Goal;
		}
		// 路径缩短或替换后，复用的多余贴花不能留下旧路线。
		for (int Index = SegmentIndex; Index < MoveIndicatorSegments.Num(); ++Index)
			MoveIndicatorSegments[Index].SetVisibility(false);
	}

	private void InitializeMoveIndicatorSegment(UDecalComponent Segment)
	{
		Segment.SetVisibility(false);
		Segment.SetAbsolute(true, true, true);
		Segment.SetDecalMaterial(MoveIndicatorMaterial);
		Segment.SetFadeScreenSize(0.0);
		Segment.CreateDynamicMaterialInstance();
		MoveIndicatorSegments.Add(Segment);
	}

	// 箭头间隔按整条剩余路径衔接，只有最后一段绘制目标圈。
	private void UpdateMoveIndicatorSegment(int Index, FVector Start, FVector Goal, float StartOffset, float RemainingDistance, bool bLastSegment)
	{
		UDecalComponent Segment = MoveIndicatorSegments[Index];
		UMaterialInstanceDynamic Material = Cast<UMaterialInstanceDynamic>(Segment.GetDecalMaterial());
		FVector Direction = Goal - Start;
		Direction.Z = 0.0;
		float Distance = Direction.Size2D();
		FVector Center = (Start + Goal) * 0.5;
		// 两端留出终点圈范围；投射深度覆盖起点与终点的高度差。
		Center.Z += 12.0;
		FVector Size = Segment.DecalSize;
		Segment.SetWorldLocation(Center);
		Segment.SetWorldRotation(FRotator(-90.0, Direction.Rotation().Yaw, 0.0));
		Segment.SetWorldScale3D(FVector(
			(28.0 + Math::Abs(Start.Z - Goal.Z) * 0.5) / Size.X,
			MoveIndicatorWidth * 0.5 / Size.Y,
			(Distance + MoveIndicatorWidth) * 0.5 / Size.Z));
		Material.SetScalarParameterValue(n"LineLength", Distance);
		Material.SetScalarParameterValue(n"LineWidth", MoveIndicatorWidth);
		Material.SetScalarParameterValue(n"StartOffset", StartOffset);
		Material.SetScalarParameterValue(n"RemainingDistance", RemainingDistance);
		Material.SetScalarParameterValue(n"EndMarker", bLastSegment ? 1.0 : 0.0);
		Segment.SetDecalColor(SelectionRing.DecalColor);
		Segment.SetVisibility(true);
	}

	private void HideMoveIndicator()
	{
		for (UDecalComponent Segment : MoveIndicatorSegments)
			Segment.SetVisibility(false);
	}
}

// 移动命令：提交、停止和到达检查；移动组件按导航请求直接更新速度。
impl AAsasiPlayerCharacter
{
	// 提交一次寻路请求；新命令结束旧路径和双方攻击，返回值表示请求是否被接受。
	UFUNCTION(BlueprintCallable, Category = "Asasi|Movement")
	bool MoveToPosition(FVector TargetPosition, AAsasiPlayerCharacter TargetCharacter = nullptr) no_discard
	{
		if (!HasAuthority())
			return false;

		StopMovement();
		AAIController AI = Cast<AAIController>(GetController());
		if (!IsValid(AI))
			return false;

		// 已能攻击时直接接管双方；从远处接近才需要计算胶囊外的站位点。
		bool bCharacterTarget = IsValid(TargetCharacter);
		FVector Destination = TargetPosition;
		float AcceptanceRadius = MoveAcceptanceRadius;
		if (bCharacterTarget)
		{
			if (TargetCharacter == this)
				return false;
			if (IsInAttackRange(TargetCharacter))
			{
				StartAttackWithCharacter(TargetCharacter);
				return true;
			}
			if (!FindAttackPosition(TargetCharacter, Destination, AcceptanceRadius))
				return false;
		}
		EPathFollowingRequestResult Result = AI.MoveToLocation(
			Dest = Destination,
			AcceptanceRadius = AcceptanceRadius,
			bStopOnOverlap = false,
			bUsePathfinding = true,
			bProjectDestinationToNavigation = !bCharacterTarget,
			bCanStrafe = false,
			FilterClass = nullptr,
			bAllowPartialPath = false);
		if (Result == EPathFollowingRequestResult::Failed)
			return false;

		MoveTargetCharacter = TargetCharacter;
		bMoveActive = true;
		// 已在站位点时立即处理到达，避免目标先移动一帧导致距离失配。
		if (Result == EPathFollowingRequestResult::AlreadyAtGoal)
			UpdateMoveCompletion();
		UpdateMoveIndicator();
		return true;
	}

	// 同时结束寻路、残留输入和双方攻击，停止后不再触发到达攻击。
	UFUNCTION(BlueprintCallable, Category = "Asasi|Movement")
	void StopMovement()
	{
		if (!HasAuthority())
			return;

		StopAttack();
		AAIController AI = Cast<AAIController>(GetController());
		if (IsValid(AI))
			AI.StopMovement();
		ConsumeMovementInputVector();
		CharacterMovement.StopMovementImmediately();
		bMoveActive = false;
		MoveTargetCharacter = nullptr;
		HideMoveIndicator();
	}

	// 到点判定交给寻路组件；路径停止后只提交待攻击目标，失去控制器时取消命令。
	private void UpdateMoveCompletion()
	{
		if (!HasAuthority() || !bMoveActive)
			return;

		AAIController AI = Cast<AAIController>(GetController());
		if (!IsValid(AI))
		{
			// 失去寻路控制器时终止命令，不把它当作到达目标。
			StopMovement();
			return;
		}
		if (AI.GetMoveStatus() != EPathFollowingStatus::Idle)
			return;

		bMoveActive = false;
		AAsasiPlayerCharacter TargetCharacter = MoveTargetCharacter;
		MoveTargetCharacter = nullptr;
		// Idle 只表示路径已停止；攻击入口按目标当前位置确认距离。
		if (TargetCharacter != nullptr)
			StartAttackWithCharacter(TargetCharacter);
	}
}

// 互攻与动画：到达后建立双方目标，动画只负责表现，移动命令立即结束攻击。
impl AAsasiPlayerCharacter
{
	// 接近合法目标后停止双方路径，解除原有互攻，再建立新的双方关系。
	private void StartAttackWithCharacter(AAsasiPlayerCharacter OtherCharacter)
	{
		if (!HasAuthority() || !IsValid(OtherCharacter) || OtherCharacter == this)
			return;
		if (!IsInAttackRange(OtherCharacter))
			return;

		StopMovement();
		OtherCharacter.StopMovement();
		AttackTarget = OtherCharacter;
		OtherCharacter.AttackTarget = this;
		SetActorRotation(FRotator(0.0, (OtherCharacter.ActorLocation - ActorLocation).Rotation().Yaw, 0.0));
		OtherCharacter.SetActorRotation(FRotator(0.0, (ActorLocation - OtherCharacter.ActorLocation).Rotation().Yaw, 0.0));
		// 只在进入攻击时启动一次；后续循环由蒙太奇保持，不按帧重播。
		PlayAnimMontage(AttackMontage);
		OtherCharacter.PlayAnimMontage(OtherCharacter.AttackMontage);
	}

	// 新命令主动解除双方关系；跨帧仍检查目标存活、关系与实际距离。
	private void UpdateAttack()
	{
		if (!HasAuthority() || AttackTarget == nullptr)
			return;
		if (!IsValid(AttackTarget) || AttackTarget.AttackTarget != this || !IsInAttackRange(AttackTarget))
			StopAttack();
	}

	// 调用方保证目标有效；半径读取移动胶囊的实际缩放尺寸，不使用选取胶囊。
	private float GetAttackCenterDistance(AAsasiPlayerCharacter OtherCharacter) const
	{
		return CapsuleComponent.GetScaledCapsuleRadius() + OtherCharacter.CapsuleComponent.GetScaledCapsuleRadius() + AttackGap;
	}

	// 在靠近自身的一侧找站位点；导航投影只占用已有容差，缺少可站空间时拒绝命令。
	private bool FindAttackPosition(AAsasiPlayerCharacter OtherCharacter, FVector &out OutPosition, float&out OutAcceptanceRadius) const
	{
		FVector Direction = (ActorLocation - OtherCharacter.ActorLocation).GetSafeNormal2D();
		// 水平位置完全相同时，用自身后方确定退让方向，不归一化零向量。
		if (Direction.IsNearlyZero())
			Direction = -ActorForwardVector.GetSafeNormal2D();
		FVector DesiredPosition = OtherCharacter.ActorLocation + Direction * GetAttackCenterDistance(OtherCharacter);
		DesiredPosition.Z -= OtherCharacter.CapsuleComponent.GetScaledCapsuleHalfHeight();
		FVector Extent(MoveAcceptanceRadius, MoveAcceptanceRadius, CapsuleComponent.GetScaledCapsuleHalfHeight() * 2.0);
		if (!UNavigationSystemV1::ProjectPointToNavigation(DesiredPosition, OutPosition, nullptr, nullptr, Extent))
			return false;
		if ((OutPosition - DesiredPosition).Size2D() > MoveAcceptanceRadius)
			return false;
		// 导航投影占用的间隙误差从到点容差中扣除，不能把两层误差叠加成更宽的攻击范围。
		float GapError = Math::Abs((OutPosition - OtherCharacter.ActorLocation).Size2D() - GetAttackCenterDistance(OtherCharacter));
		OutAcceptanceRadius = MoveAcceptanceRadius - GapError;
		return OutAcceptanceRadius > 0.0;
	}

	// 普通近战只限制最大间隙，不因贴身而后退；身体占位由移动胶囊阻挡保证。
	private bool IsInAttackRange(AAsasiPlayerCharacter OtherCharacter)
	{
		FVector Delta = ActorLocation - OtherCharacter.ActorLocation;
		if (Delta.Size2D() > GetAttackCenterDistance(OtherCharacter) + MoveAcceptanceRadius)
			return false;
		// 用脚下高度区分楼层，体型不同但站在同一地面的角色仍可接敌。
		float SelfHalfHeight = CapsuleComponent.GetScaledCapsuleHalfHeight();
		float OtherHalfHeight = OtherCharacter.CapsuleComponent.GetScaledCapsuleHalfHeight();
		if (Math::Abs(Delta.Z - SelfHalfHeight + OtherHalfHeight) > Math::Min(SelfHalfHeight, OtherHalfHeight))
			return false;
		TArray<AActor> Ignored;
		Ignored.Add(this);
		Ignored.Add(OtherCharacter);
		FHitResult Hit;
		return !System::LineTraceSingle(
			Start = ActorLocation,
			End = OtherCharacter.ActorLocation,
			TraceChannel = ETraceTypeQuery::Visibility,
			bTraceComplex = false,
			ActorsToIgnore = Ignored,
			DrawDebugType = EDrawDebugTrace::None,
			OutHit = Hit,
			bIgnoreSelf = true);
	}

	// 先清自身，再清仍与自身配对的对象；不递归调用，也不影响对方的新目标。
	private void StopAttack()
	{
		if (!HasAuthority())
			return;

		AAsasiPlayerCharacter OtherCharacter = AttackTarget;
		AttackTarget = nullptr;
		StopAttackAnimation();
		if (IsValid(OtherCharacter) && OtherCharacter.AttackTarget == this)
		{
			OtherCharacter.AttackTarget = nullptr;
			OtherCharacter.StopAttackAnimation();
		}
	}

	// 只停止自己的攻击蒙太奇，混出时间读取资产；移动 AnimBP 始终保持运行。
	private void StopAttackAnimation()
	{
		if (AttackMontage != nullptr)
			StopAnimMontage(AttackMontage);
	}
}
